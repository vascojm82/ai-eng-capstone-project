/**
 * Sets up the phone agent in Retell (in the workspace RETELL_API_KEY belongs
 * to): the Retell LLM, the agent, and the phone number it answers.
 *
 *   caller ⇄ Retell (speech, its LLM, the voice) ── owners_manual_lookup ──▶ POST /api/voice/ask
 *
 * Retell's LLM runs the call: it greets the caller, asks for the car, and for
 * every car question calls the owners_manual_lookup tool, which POSTs the
 * question to our /api/voice/ask (routes/voice.ts). That endpoint runs the
 * same agent as the web chat, so the search and the scope rules live there,
 * not in Retell.
 *
 * Safe to run again: it finds the agent by name and updates it and its LLM in
 * place instead of creating new ones. It never buys a phone number: buy it in
 * the Retell dashboard and put it in .env as RETELL_PHONE_NUMBER.
 *
 * Usage:
 *   npm run voice:setup
 *   npm run voice:setup -- --dry-run     # print what would be sent, change nothing
 *
 * The tool calls RETELL_TOOL_URL from .env: your deployed app's
 * https://<your-app-host>/api/voice/ask. To test against your machine, expose
 * `npm run dev` with ngrok and override it for one run (the shell wins over .env):
 *   RETELL_TOOL_URL=https://<your-ngrok-host>/api/voice/ask npm run voice:setup
 * then run `npm run voice:setup` again afterwards to point back to your app.
 */

import type Retell from "retell-sdk";
import { AGENT_NAME, findAgent, getPhoneNumber, retellFromEnv } from "./retell.ts";

// Where the owners_manual_lookup tool sends questions: the /api/voice/ask of your deployed app
const TOOL_URL = process.env.RETELL_TOOL_URL ?? "";
// The small GPT-6 model: Retell's LLM only runs the conversation, our server does the search.
// Set with `model`/`model_temperature`: retell-sdk 6.2.7 doesn't have the newer `model_config` yet.
const MODEL = "gpt-6-luna";
const VOICE_ID = "cartesia-Andrew"; // a standard voice ($0.015/min); ElevenLabs voices cost more
const MODELS = ["ADX", "ILX", "Integra", "MDX", "NSX", "RDX", "TLX", "ZDX"];

// A demo, not affiliated with Acura: the agent calls itself just "the Service Assistant"
const GENERAL_PROMPT = `You are the Service Assistant. You answer phone calls from Acura owners with questions about their vehicle. You are not part of Acura: never say you're from Acura or speak on Acura's behalf.

- For every question about an Acura vehicle (features, settings, maintenance, specifications, warning lights, navigation, problems with the car…), call owners_manual_lookup and answer only from its result. Never answer car questions from your own knowledge.
- The question you pass must include the car's model year in digits and its model, e.g. "How do I check the tire pressure on a 2026 MDX?". If the caller hasn't said both, ask for what's missing before calling the tool. Once they've told you, keep using that car for the rest of the call unless they mention another one.
- Read the result to the caller naturally, keeping its facts, numbers and units exactly. Don't add anything to it. If it starts with a recommendation to make a dealer appointment, say that first.
- After you've answered the caller's question, ask "Is there anything else I can help you with?"
- If the result asks for the model year or model, ask the caller. If it says the manual doesn't cover the question, tell the caller and suggest contacting an Acura dealer.
- If the caller asks about something that has nothing to do with Acura vehicles, say "Please ask a question about Acura cars." without calling the tool.
- If the tool fails, apologize and suggest calling back later or contacting an Acura dealer.
- This is a phone call: keep replies short and ask one question at a time.
- When the caller says they have no more questions or says goodbye, say goodbye and end the call.`;

const LLM: Retell.LlmCreateParams = {
  model: MODEL,
  model_temperature: 0, // Retell recommends a low value for tool calling
  start_speaker: "agent",
  begin_message: "Hi, this is the Service Assistant. This call may be recorded. How can I help you with your Acura today?",
  general_prompt: GENERAL_PROMPT,
  general_tools: [
    {
      type: "custom",
      name: "owners_manual_lookup",
      description:
        "Looks up the answer to the customer's Acura question in the owner's and navigation manuals. Always include the car's model year and model, even if the customer said them earlier in the call.",
      url: TOOL_URL,
      method: "POST",
      // Leave args_at_root off: /api/voice/ask reads call.from_number for its per-caller limit
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The customer's question, with the model year in digits and the model name, e.g. 'How do I check the tire pressure on a 2026 MDX?'",
          },
        },
        required: ["question"],
      },
      speak_during_execution: true,
      execution_message_type: "prompt",
      execution_message_description: "Briefly tell the caller you're checking the owner's manual.",
      speak_after_execution: true,
      timeout_ms: 30_000, // answers take 3–10 s, more right after a deploy
    },
    {
      type: "end_call",
      name: "end_call",
      description: "End the call when the caller says they have no more questions or says goodbye.",
    },
  ],
};

/** The agent's settings, without the LLM link (added once the LLM exists) */
const AGENT = {
  agent_name: AGENT_NAME,
  voice_id: VOICE_ID,
  language: "en-US",
  // A bit slower than the default 1 (range 0.5–2), so callers can follow step-by-step instructions
  voice_speed: 0.8,
  // Helps speech-to-text hear the model names right
  boosted_keywords: ["Acura", ...MODELS],
  max_call_duration_ms: 10 * 60 * 1000, // 10 minutes, caps the cost of one call
  end_call_after_silence_ms: 30_000, // give callers time to find their car's details
} satisfies Omit<Retell.AgentCreateParams, "response_engine">;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { client, phoneNumber } = retellFromEnv();
  if (!/^https:\/\/.+\/api\/voice\/ask$/.test(TOOL_URL)) {
    console.error("RETELL_TOOL_URL must be set in .env to your app's https://<host>/api/voice/ask");
    process.exit(1);
  }

  console.log(`Tool URL: ${TOOL_URL}`);
  if (dryRun) {
    console.log(JSON.stringify({ llm: LLM, agent: AGENT }, null, 2));
    console.log("Dry run: nothing was changed.");
    return;
  }

  await getPhoneNumber(client, phoneNumber);
  const existing = await findAgent(client);
  let agentId: string;
  if (existing) {
    if (existing.response_engine.type !== "retell-llm") {
      console.error(`The agent "${AGENT_NAME}" doesn't use a Retell LLM; rename or delete it in the dashboard first.`);
      process.exit(1);
    }
    const llmId = existing.response_engine.llm_id;
    await client.llm.update(llmId, LLM);
    await client.agent.update(existing.agent_id, { ...AGENT, response_engine: { type: "retell-llm", llm_id: llmId } });
    agentId = existing.agent_id;
    console.log(`Updated the LLM (${llmId}) and the agent "${AGENT_NAME}" (${agentId}).`);
  } else {
    const llm = await client.llm.create(LLM);
    const agent = await client.agent.create({ ...AGENT, response_engine: { type: "retell-llm", llm_id: llm.llm_id } });
    agentId = agent.agent_id;
    console.log(`Created the LLM (${llm.llm_id}) and the agent "${AGENT_NAME}" (${agentId}).`);
  }

  // "latest": the number always uses the agent's newest version, so re-running this script takes effect
  await client.phoneNumber.update(phoneNumber, {
    nickname: AGENT_NAME,
    inbound_agents: [{ agent_id: agentId, agent_version: "latest", weight: 1 }],
  });
  console.log(`The phone number now answers with "${AGENT_NAME}". Call it to try it.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * Turns the demo phone line on or off, so Retell only answers (and bills
 * per minute) while you're running a demo.
 *
 *   off:    removes the agent from RETELL_PHONE_NUMBER; Retell stops answering it
 *   on:     assigns the "Service Assistant" agent to the number again
 *   status: shows whether the line is on, changing nothing
 *
 * Only the number's inbound agent changes: the agent, its prompt, voice and
 * tool URL stay as `npm run voice:setup` left them. You keep the number
 * (about $2 a month) while the line is off.
 *
 * Usage:
 *   npm run voice:on
 *   npm run voice:off
 *   npm run voice:status
 */

import { AGENT_NAME, findAgent, getPhoneNumber, retellFromEnv } from "./retell.ts";

const ACTIONS = ["on", "off", "status"] as const;
type Action = (typeof ACTIONS)[number];

async function main() {
  const action = process.argv[2] as Action;
  if (!ACTIONS.includes(action)) {
    console.error(`Usage: toggle-retell.ts ${ACTIONS.join(" | ")}`);
    process.exit(1);
  }
  const { client, phoneNumber } = retellFromEnv();
  const agent = await findAgent(client);
  if (!agent) {
    console.error(`There's no agent named "${AGENT_NAME}" in this Retell workspace. Run "npm run voice:setup" first.`);
    process.exit(1);
  }

  if (action === "on") {
    // "latest", as voice:setup sets it, so later voice:setup runs take effect right away
    await client.phoneNumber.update(phoneNumber, {
      inbound_agents: [{ agent_id: agent.agent_id, agent_version: "latest", weight: 1 }],
    });
  } else if (action === "off") {
    await client.phoneNumber.update(phoneNumber, { inbound_agents: null });
  }

  const { inbound_agents } = await getPhoneNumber(client, phoneNumber);
  const on = Boolean(inbound_agents?.some((a) => a.agent_id === agent.agent_id));
  console.log(
    on
      ? `The line is ON: the number answers with "${AGENT_NAME}".`
      : `The line is OFF: no agent answers the number. Run "npm run voice:on" before a demo.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

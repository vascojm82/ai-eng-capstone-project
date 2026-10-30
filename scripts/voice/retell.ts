// What the voice scripts share: the agent's name, the .env settings, the
// Retell client, and finding the agent and the phone number in Retell.

import Retell from "retell-sdk";

export const AGENT_NAME = "Service Assistant";

/** The Retell client and RETELL_PHONE_NUMBER from .env; exits with a message when they're missing */
export function retellFromEnv() {
  const apiKey = process.env.RETELL_API_KEY;
  const phoneNumber = process.env.RETELL_PHONE_NUMBER;
  if (!apiKey || !phoneNumber) {
    console.error("RETELL_API_KEY and RETELL_PHONE_NUMBER must be set in .env");
    process.exit(1);
  }
  if (!/^\+1\d{10}$/.test(phoneNumber)) {
    console.error("RETELL_PHONE_NUMBER must be in E.164 format, e.g. +14155551234");
    process.exit(1);
  }
  return { client: new Retell({ apiKey }), phoneNumber };
}

/** The phone number's settings in Retell; exits when it isn't in this workspace */
export async function getPhoneNumber(client: Retell, phoneNumber: string) {
  const info = await client.phoneNumber.retrieve(phoneNumber).catch(() => null);
  if (!info) {
    console.error("RETELL_PHONE_NUMBER isn't a number in this Retell workspace. Buy it in the dashboard first.");
    process.exit(1);
  }
  return info;
}

/** The voice agent named AGENT_NAME, if it exists */
export async function findAgent(client: Retell) {
  let pagination_key: string | undefined;
  do {
    const page = await client.agent.list({ limit: 100, pagination_key });
    const agent = page.items.find((a) => a.agent_name === AGENT_NAME);
    if (agent) return client.agent.retrieve(agent.agent_id);
    pagination_key = page.has_more ? page.pagination_key : undefined;
  } while (pagination_key);
  return null;
}

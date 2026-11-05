// Replaces ../api for ws.ts in real-chain.browser.spec.ts: ticket + relay URL point at the in-process fake relay.
export const RELAY_WSS_URL: string = (window as unknown as { __relayUrl: string }).__relayUrl;
export async function getWsTicket(): Promise<{ ticket: string }> {
  return { ticket: 'fake-ticket' };
}

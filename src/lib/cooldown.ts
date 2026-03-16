import { getRedis } from "./redis";

const COOLDOWN_TTL = 8 * 60 * 60; // 8 hours in seconds

function cooldownKey(symbol: string, alertType: string): string {
  return `cooldown:${symbol}:${alertType}`;
}

export async function isCooldownActive(
  symbol: string,
  alertType: string
): Promise<boolean> {
  const redis = getRedis();
  const val = await redis.get(cooldownKey(symbol, alertType));
  return val !== null;
}

export async function setCooldown(
  symbol: string,
  alertType: string
): Promise<void> {
  const redis = getRedis();
  await redis.set(cooldownKey(symbol, alertType), Date.now(), {
    ex: COOLDOWN_TTL,
  });
}

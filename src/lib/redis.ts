import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error("Missing Upstash Redis environment variables");
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

export const ALERTS_QUEUE_KEY = "alerts:queue";

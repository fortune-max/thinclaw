import { config } from "../config.js";

export function isAllowed(userId: number): boolean {
  // Admins always allowed
  if (config.ADMIN_USER_IDS.includes(userId)) return true;
  // Guests allowed if enabled
  return config.ALLOW_GUESTS;
}

export function isAdmin(userId: number): boolean {
  return config.ADMIN_USER_IDS.includes(userId);
}

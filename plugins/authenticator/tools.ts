import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import * as OTPAuth from "otpauth";

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "auth_list_services",
      description:
        "List all configured 2FA services that have TOTP codes available.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "auth_get_code",
      description:
        "Generate a current TOTP 2FA code for a service. The code is valid for ~30 seconds.",
      input_schema: {
        type: "object" as const,
        properties: {
          service: {
            type: "string",
            description:
              "Service name (e.g., 'flutterwave', 'grey'). Case-insensitive.",
          },
        },
        required: ["service"],
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async auth_list_services(_input, secrets) {
      const services = Object.keys(secrets)
        .filter((k) => k.startsWith("TOTP_"))
        .map((k) => k.replace("TOTP_", "").toLowerCase());

      if (services.length === 0) return "No 2FA services configured.";
      return `Available services: ${services.join(", ")}`;
    },

    async auth_get_code(input, secrets) {
      const { service } = input as { service: string };
      const key = `TOTP_${service.toUpperCase()}`;
      const secret = secrets[key];

      if (!secret) {
        const available = Object.keys(secrets)
          .filter((k) => k.startsWith("TOTP_"))
          .map((k) => k.replace("TOTP_", "").toLowerCase());
        return `Service "${service}" not found. Available: ${available.join(", ")}`;
      }

      const totp = new OTPAuth.TOTP({
        secret: OTPAuth.Secret.fromBase32(secret),
        digits: 6,
        period: 30,
      });

      const code = totp.generate();
      const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);

      return `${code} (valid for ${remaining}s)`;
    },
  };

  return { tools, handlers };
}

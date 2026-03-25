import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";

const BASE_URL = "https://webservices.edenred.es/gateway-app";

let cachedToken: string | null = null;
let tokenExpiry = 0;
let lastOtpGuid: string | null = null;

async function login(secrets: Record<string, string>): Promise<string> {
  // Reuse token if still fresh (30 min TTL)
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${BASE_URL}/Identity/Anonymous/User/LoginValidation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://empleados.edenred.es",
    },
    body: JSON.stringify({
      userName: secrets.EDENRED_USERNAME,
      password: secrets.EDENRED_PASSWORD,
      browser: "bot",
    }),
  });

  if (!res.ok) throw new Error(`Edenred login failed: ${res.status}`);
  const data = await res.json();

  if (data.meta?.status !== "SUCCESS" || !data.data?.token) {
    throw new Error(`Edenred login failed: ${data.meta?.messages?.[0] || "unknown error"}`);
  }

  if (data.data.isOtpRequired) {
    lastOtpGuid = data.data.otpGuid;
    throw new Error(
      `Edenred requires email OTP verification. ` +
      `An OTP code was sent to ${data.data.otpEmail}. ` +
      `Use the Gmail plugin to find the code from noreply@notificaciones.edenred.info with subject "Código de verificación", ` +
      `then call edenred_verify_otp with the code and token "${data.data.token}".`
    );
  }

  cachedToken = data.data.token;
  tokenExpiry = Date.now() + 30 * 60 * 1000;
  return cachedToken!;
}

async function edenredFetch(path: string, token: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: "https://empleados.edenred.es",
    },
  });

  if (!res.ok) {
    // Token might be expired
    if (res.status === 401) {
      cachedToken = null;
      tokenExpiry = 0;
      throw new Error("Edenred session expired. Try again.");
    }
    throw new Error(`Edenred API ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "edenred_balance",
      description:
        "Check Edenred Ticket Restaurant card balance.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "edenred_verify_otp",
      description:
        "Verify Edenred email OTP code. Call this after edenred_balance/edenred_transactions returns an OTP error. Get the code from Gmail first.",
      input_schema: {
        type: "object" as const,
        properties: {
          token: { type: "string", description: "Token from the login error message" },
          otp_code: { type: "string", description: "6-digit OTP code from the email" },
        },
        required: ["token", "otp_code"],
      },
    },
    {
      name: "edenred_transactions",
      description:
        "Get recent Edenred Ticket Restaurant transactions. Shows where and how much was spent.",
      input_schema: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Number of transactions to show (default 5, max 20)",
          },
        },
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async edenred_verify_otp(input) {
      const { token, otp_code } = input as { token: string; otp_code: string };

      // Login response includes otpGuid — extract from the cached error or use token
      const res = await fetch(`${BASE_URL}/Identity/OTP/Validation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          Origin: "https://empleados.edenred.es",
        },
        body: JSON.stringify({ otp: otp_code, guid: lastOtpGuid }),
      });

      if (!res.ok) {
        throw new Error(`Edenred OTP verification failed: ${res.status} ${await res.text()}`);
      }

      cachedToken = token;
      tokenExpiry = Date.now() + 30 * 60 * 1000;
      return "OTP verified. Edenred is now authenticated. Try your request again.";
    },

    async edenred_balance(_input, secrets) {
      const token = await login(secrets);
      const data = await edenredFetch("/User/EmployeeProductsAndCards", token);

      const products = data.data || [];
      const activeCards = products
        .filter((p: any) => p.cardsInfo?.length > 0)
        .flatMap((p: any) =>
          p.cardsInfo.map((c: any) => ({
            product: p.productName,
            balance: c.balance,
            card: c.cardMaskedPanNumber,
          })),
        );

      if (activeCards.length === 0) return "No active Edenred cards found.";

      return activeCards
        .map((c: any) => `${c.product}: €${c.balance.toFixed(2)} (${c.card})`)
        .join("\n");
    },

    async edenred_transactions(input, secrets) {
      const { limit = 5 } = input as { limit?: number };
      const token = await login(secrets);

      // First get the card GUID
      const cards = await edenredFetch("/User/EmployeeProductsAndCards", token);
      const cardInfo = cards.data
        ?.flatMap((p: any) => p.cardsInfo || [])
        ?.find((c: any) => c.id);

      if (!cardInfo) return "No active card found.";

      const count = Math.min(limit, 20);
      const txData = await edenredFetch(
        `/User/EmployeeTransactionSearch?numberOfRecordsPerPage=${count}&pageNumber=0&cardGuid=${cardInfo.id}`,
        token,
      );

      const rows = txData.data?.rows || [];
      if (rows.length === 0) return "No recent transactions.";

      return rows
        .map((tx: any) => {
          const amount = tx.transactionAmount >= 0
            ? `+€${tx.transactionAmount.toFixed(2)}`
            : `-€${Math.abs(tx.transactionAmount).toFixed(2)}`;
          return `${tx.transactionDateWithoutHour} ${amount} — ${tx.transactionDescription}`;
        })
        .join("\n");
    },
  };

  return { tools, handlers };
}

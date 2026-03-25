import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import crypto from "crypto";

const API_BASE = "https://api-dashboard.flutterwave.com";

// Per-user session state (keyed by secrets hash as proxy for user identity)
const sessions = new Map<string, { token: string; expiry: number }>();

function getSession(secrets: Record<string, string>): string | null {
  const key = secrets.FLW_EMAIL || "default";
  const session = sessions.get(key);
  if (session && session.expiry > Date.now()) return session.token;
  return null;
}

function setSession(secrets: Record<string, string>, token: string): void {
  const key = secrets.FLW_EMAIL || "default";
  sessions.set(key, { token, expiry: Date.now() + 10 * 60 * 1000 });
}

function deviceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function flwFetch(
  path: string,
  secrets: Record<string, string>,
  options: RequestInit = {},
): Promise<any> {
  const sessionToken = getSession(secrets);
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "v3-xapp-id": "1",
      ...(sessionToken ? { "flw-auth-token": sessionToken } : {}),
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });

  const data = await res.json();

  if (!res.ok && data.status === "error") {
    throw new Error(data.message || `Flutterwave API ${res.status}`);
  }

  return data;
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "flw_login",
      description:
        "Login to Flutterwave dashboard. This is the first step — returns a partial auth token. Must be followed by flw_verify_2fa with a TOTP code from the authenticator plugin.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "flw_verify_2fa",
      description:
        "Complete Flutterwave login by providing the TOTP 2FA code. Use the authenticator plugin (auth_get_code for 'flutterwave') to get the code first.",
      input_schema: {
        type: "object" as const,
        properties: {
          totp_code: {
            type: "string",
            description: "6-digit TOTP code from the authenticator",
          },
        },
        required: ["totp_code"],
      },
    },
    {
      name: "flw_whitelist_ip_init",
      description:
        "Start whitelisting an IP address on Flutterwave. This triggers an OTP email to the account owner. Must be logged in first (flw_login + flw_verify_2fa). After calling this, ask the user for the email OTP.",
      input_schema: {
        type: "object" as const,
        properties: {
          ip_address: {
            type: "string",
            description: "IP address to whitelist (e.g., '91.91.91.91')",
          },
        },
        required: ["ip_address"],
      },
    },
    {
      name: "flw_whitelist_ip_confirm",
      description:
        "Complete IP whitelisting by providing the email OTP. Call this after flw_whitelist_ip_init once the user provides the OTP from their email.",
      input_schema: {
        type: "object" as const,
        properties: {
          ip_address: {
            type: "string",
            description: "Same IP address from the init step",
          },
          email_otp: {
            type: "string",
            description: "OTP code received via email",
          },
        },
        required: ["ip_address", "email_otp"],
      },
    },
    {
      name: "flw_get_whitelisted_ips",
      description:
        "List all currently whitelisted IP addresses. Must be logged in first.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "flw_buy_airtime",
      description:
        "Buy airtime for a Nigerian mobile number. Must be logged in. The phone number should be in format 08XXXXXXXXX (will be converted to 234 format).",
      input_schema: {
        type: "object" as const,
        properties: {
          phone_number: {
            type: "string",
            description: "Nigerian phone number (e.g., '08083454312')",
          },
          amount: {
            type: "number",
            description: "Amount in NGN (e.g., 50, 100, 500)",
          },
        },
        required: ["phone_number", "amount"],
      },
    },
    {
      name: "flw_resolve_account",
      description:
        "Resolve a bank account number to get the account holder's name. Use before making a transfer to verify the recipient. Must be logged in.",
      input_schema: {
        type: "object" as const,
        properties: {
          account_number: {
            type: "string",
            description: "Bank account number",
          },
          bank_code: {
            type: "string",
            description: "Bank code (e.g., '058' for GTBank, '100033' for PalmPay). Use flw_search_beneficiaries or check common bank codes.",
          },
        },
        required: ["account_number", "bank_code"],
      },
    },
    {
      name: "flw_search_beneficiaries",
      description:
        "Search saved payout beneficiaries by name. Returns account details and bank codes. Must be logged in.",
      input_schema: {
        type: "object" as const,
        properties: {
          query: {
            type: "string",
            description: "Name to search (e.g., 'scott', 'fortune')",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "flw_transfer",
      description:
        "Transfer money to a bank account. Requires security PIN. Must be logged in. Resolve the account first with flw_resolve_account to confirm the recipient name.",
      input_schema: {
        type: "object" as const,
        properties: {
          account_number: { type: "string", description: "Recipient bank account number" },
          bank_code: { type: "string", description: "Recipient bank code" },
          bank_name: { type: "string", description: "Recipient bank name (e.g., 'PALMPAY', 'GTBank')" },
          beneficiary_name: { type: "string", description: "Recipient full name (from resolve)" },
          amount: { type: "number", description: "Amount in NGN" },
          narration: { type: "string", description: "Transfer narration/description" },
        },
        required: ["account_number", "bank_code", "bank_name", "beneficiary_name", "amount", "narration"],
      },
    },
    {
      name: "flw_get_balance",
      description:
        "Get wallet balances across all currencies. Must be logged in.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async flw_login(_input, secrets) {
      const data = await flwFetch(`/login?device_id=${deviceId()}`, secrets, {
        method: "POST",
        body: JSON.stringify({
          identifier: secrets.FLW_EMAIL,
          password: secrets.FLW_PASSWORD,
          last_viewed_page: true,
        }),
      });

      const token = data.data?.["flw-auth-token"];
      if (!token) throw new Error("No auth token in login response");
      setSession(secrets, token);

      return "Logged in — now need 2FA verification. Use auth_get_code for 'flutterwave' then call flw_verify_2fa.";
    },

    async flw_verify_2fa(input, secrets) {
      const { totp_code } = input as { totp_code: string };
      const accountId = parseInt(secrets.FLW_ACCOUNT_ID);

      const data = await flwFetch("/merchant/tokens/create", secrets, {
        method: "POST",
        body: JSON.stringify({
          account: accountId,
          token: totp_code,
        }),
      });

      const token = data.data?.["flw-auth-token"];
      if (token) setSession(secrets, token);

      return "2FA verified — fully authenticated. You can now perform actions.";
    },

    async flw_whitelist_ip_init(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { ip_address } = input as { ip_address: string };

      try {
        await flwFetch("/v2/ipwhitelist", secrets, {
          method: "POST",
          body: JSON.stringify({
            action: "add",
            value: ip_address,
            resend_otp: 1,
          }),
        });
      } catch (err: any) {
        if (err.message?.includes("OTP")) {
          return `Email OTP sent to the account email. Ask the user for the code, then call flw_whitelist_ip_confirm with ip_address="${ip_address}" and the email_otp.`;
        }
        throw err;
      }

      return "Whitelist request sent. Check if an email OTP is needed.";
    },

    async flw_whitelist_ip_confirm(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { ip_address, email_otp } = input as {
        ip_address: string;
        email_otp: string;
      };

      await flwFetch("/v2/ipwhitelist", secrets, {
        method: "POST",
        body: JSON.stringify({
          action: "add",
          value: ip_address,
          resend_otp: 1,
          rave_otp: email_otp,
        }),
      });

      return `IP ${ip_address} whitelisted successfully.`;
    },

    async flw_get_whitelisted_ips(_input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const data = await flwFetch("/flwv3-pug/getpaidx/api/ip", secrets, {
        method: "GET",
      });

      return JSON.stringify(data, null, 2);
    },

    async flw_buy_airtime(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { phone_number, amount } = input as { phone_number: string; amount: number };

      // Convert 08... to 234... format
      let mobile = phone_number.replace(/^0/, "234");
      if (!mobile.startsWith("234")) mobile = "234" + mobile;

      const reference = `FLW-bill-${Date.now()}${Math.floor(Math.random() * 1000)}`;

      if (amount < 50) throw new Error("Minimum airtime amount is ₦50");

      const data = await flwFetch("/v2/services/confluence_a", secrets, {
        method: "POST",
        body: JSON.stringify({
          service: "fly_buy",
          service_method: "post",
          service_version: "v1",
          service_channel: "rave",
          service_payload: {
            mobile_number: mobile,
            customer_id: mobile,
            amount,
            country: "NG",
            biller_name: "AIRTIME",
            transaction_reference: reference,
            is_airtime: true,
            RecurringType: 0,
          },
        }),
      });

      const result = data.data;

      // Check for failure — response can come in different formats
      if (result?.Code === "400" || result?.Status === "failed") {
        throw new Error(`Airtime purchase failed: ${result?.Message || "Unknown error"}`);
      }

      return `Airtime sent: ₦${amount} to ${result?.MobileNumber || mobile} (${result?.Network || "unknown"}).\nRef: ${result?.TransactionReference || reference}`;
    },

    async flw_resolve_account(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { account_number, bank_code } = input as { account_number: string; bank_code: string };

      const data = await flwFetch("/account/resolve", secrets, {
        method: "POST",
        body: JSON.stringify({
          recipientaccount: account_number,
          destbankcode: bank_code,
        }),
      });

      const resolved = data.data?.data;
      if (!resolved || resolved.responsecode !== "00") {
        return `Failed to resolve account: ${resolved?.responsemessage || "Unknown error"}`;
      }

      return `Account resolved: ${resolved.accountname} (${account_number})`;
    },

    async flw_search_beneficiaries(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { query } = input as { query: string };

      const data = await flwFetch(`/v2/beneficiaries?q=${encodeURIComponent(query)}&limit=10`, secrets, {
        method: "GET",
      });

      const beneficiaries = data.data?.payout_beneficiaries || [];
      if (beneficiaries.length === 0) return `No beneficiaries found for "${query}"`;

      return JSON.stringify(
        beneficiaries.map((b: any) => ({
          id: b.id,
          name: b.fullname,
          account_number: b.account_number,
          bank_code: b.bank_code,
          bank_name: b.meta?.[0]?.BankName || "Unknown",
        })),
        null,
        2,
      );
    },

    async flw_transfer(input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const { account_number, bank_code, bank_name, beneficiary_name, amount, narration } = input as {
        account_number: string;
        bank_code: string;
        bank_name: string;
        beneficiary_name: string;
        amount: number;
        narration: string;
      };

      const pin = secrets.FLW_SECURITY_PIN;
      if (!pin) throw new Error("Missing FLW_SECURITY_PIN secret. Set it with set_secret('flutterwave', 'FLW_SECURITY_PIN', 'value') or add it to env vars.");

      const nameParts = beneficiary_name.split(" ");
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(" ");
      const reference = `TRF-${Date.now()}`;

      const meta = [{
        BeneficiaryCountry: "NG",
        AccountNumber: account_number,
        FirstName: firstName,
        LastName: lastName,
        BankName: bank_name,
        RoutingNumber: bank_code,
        Sender: "Fortune Max-Eguakun",
        SenderCountry: "NG",
      }];

      const data = await flwFetch("/v2/transfers/create", secrets, {
        method: "POST",
        body: JSON.stringify({
          account_bank: bank_code,
          account_number,
          destination_branch_code: null,
          beneficiary_name,
          currency: "NGN",
          reference,
          meta,
          beneficiary_meta: meta,
          amount,
          debit_currency: "NGN",
          narration,
          pin,
        }),
      });

      const transfer = data.data;
      return `Transfer created: ₦${amount} to ${beneficiary_name} (${bank_name})\nStatus: ${transfer?.status || "NEW"}\nRef: ${transfer?.reference || reference}\nFee: ₦${transfer?.fee || 0}`;
    },

    async flw_get_balance(_input, secrets) {
      if (!getSession(secrets)) throw new Error("Not logged in. Call flw_login first.");

      const data = await flwFetch("/v2/services/confluence_a", secrets, {
        method: "POST",
        body: JSON.stringify({
          service: "disbursement_customer_wallets",
          service_method: "get",
          service_version: "v1",
          service_channel: "rave",
          service_payload: {},
        }),
      });

      const wallets = data.data?.SimpleWalletWithBalances || [];
      const ngn = wallets.find((w: any) => w.ShortName === "NGN");
      if (!ngn) return "NGN wallet not found.";
      return `NGN Balance: ₦${ngn.AvailableBalance.toLocaleString()}`;
    },
  };

  return { tools, handlers };
}

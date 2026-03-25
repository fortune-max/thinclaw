import type Anthropic from "@anthropic-ai/sdk";
import type { ToolHandler } from "../../src/plugins/types.js";
import { TonClient, WalletContractV4, internal, Address } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

const TONCENTER_ENDPOINT = "https://toncenter.com/api/v2/jsonRPC";
const NANOTON = 1_000_000_000n;

function getClient(): TonClient {
  return new TonClient({ endpoint: TONCENTER_ENDPOINT });
}

function formatTon(nanotons: bigint): string {
  const whole = nanotons / NANOTON;
  const frac = nanotons % NANOTON;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

async function getWallet(secrets: Record<string, string>) {
  const mnemonic = secrets.TON_MNEMONIC;
  if (!mnemonic) throw new Error("TON_MNEMONIC not set.");

  const keyPair = await mnemonicToPrivateKey(mnemonic.split(" "));
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  return { wallet, keyPair };
}

export function createTools(_secrets: Record<string, string>): {
  tools: Anthropic.Tool[];
  handlers: Record<string, ToolHandler>;
} {
  const tools: Anthropic.Tool[] = [
    {
      name: "ton_balance",
      description:
        "Check TON wallet balance. If no address is given, checks your own wallet.",
      input_schema: {
        type: "object" as const,
        properties: {
          address: {
            type: "string",
            description: "TON wallet address to check. Leave empty to check your own wallet.",
          },
        },
      },
    },
    {
      name: "ton_transactions",
      description:
        "Get recent transactions for a TON wallet. Shows incoming and outgoing transfers.",
      input_schema: {
        type: "object" as const,
        properties: {
          address: {
            type: "string",
            description: "TON wallet address. Leave empty for your own wallet.",
          },
          limit: {
            type: "number",
            description: "Number of transactions to show (default 5, max 20)",
          },
        },
      },
    },
    {
      name: "ton_send",
      description:
        "Send TON to an address. Requires Telegram confirmation before executing.",
      input_schema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "Recipient TON wallet address" },
          amount: { type: "string", description: "Amount in TON (e.g., '1.5')" },
          message: {
            type: "string",
            description: "Optional message/comment to include with the transfer",
          },
        },
        required: ["to", "amount"],
      },
    },
    {
      name: "ton_my_address",
      description: "Get your own TON wallet address.",
      input_schema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];

  const handlers: Record<string, ToolHandler> = {
    async ton_balance(input, secrets) {
      const client = getClient();
      let addr: Address;

      if (input.address) {
        addr = Address.parse(input.address as string);
      } else {
        const { wallet } = await getWallet(secrets);
        addr = wallet.address;
      }

      const balance = await client.getBalance(addr);
      return `Balance: ${formatTon(balance)} TON\nAddress: ${addr.toString()}`;
    },

    async ton_transactions(input, secrets) {
      const client = getClient();
      const limit = Math.min((input.limit as number) || 5, 20);
      let addr: Address;

      if (input.address) {
        addr = Address.parse(input.address as string);
      } else {
        const { wallet } = await getWallet(secrets);
        addr = wallet.address;
      }

      const txs = await client.getTransactions(addr, { limit });

      if (txs.length === 0) return "No transactions found.";

      const results: string[] = [];

      for (const tx of txs) {
        const date = new Date(tx.now * 1000).toISOString().slice(0, 16).replace("T", " ");
        const inMsg = tx.inMessage;

        if (inMsg?.info.type === "internal") {
          const amount = formatTon(inMsg.info.value.coins);
          const from = inMsg.info.src?.toString() || "unknown";
          const body = inMsg.body?.toString() || "";
          results.push(`${date} ← +${amount} TON from ${from.slice(0, 20)}...${body ? ` "${body}"` : ""}`);
        }

        for (const [, outMsg] of tx.outMessages) {
          if (outMsg.info.type === "internal") {
            const amount = formatTon(outMsg.info.value.coins);
            const to = outMsg.info.dest?.toString() || "unknown";
            results.push(`${date} → -${amount} TON to ${to.slice(0, 20)}...`);
          }
        }
      }

      if (results.length === 0) return "No transfer transactions found.";
      return results.join("\n");
    },

    async ton_send(input, secrets) {
      const { to, amount, message = "" } = input as {
        to: string;
        amount: string;
        message?: string;
      };

      const client = getClient();
      const { wallet, keyPair } = await getWallet(secrets);
      const walletContract = client.open(wallet);

      // Check balance
      const balance = await walletContract.getBalance();
      const amountNano = BigInt(Math.floor(parseFloat(amount) * 1e9));

      if (balance < amountNano) {
        throw new Error(
          `Insufficient balance. Have ${formatTon(balance)} TON, need ${amount} TON.`,
        );
      }

      const seqno = await walletContract.getSeqno();

      await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: Address.parse(to),
            value: amount,
            body: message || undefined,
            bounce: false,
          }),
        ],
      });

      return `Sent ${amount} TON to ${to}${message ? ` with message: "${message}"` : ""}`;
    },

    async ton_my_address(_input, secrets) {
      const { wallet } = await getWallet(secrets);
      return `Your TON wallet address:\n${wallet.address.toString()}`;
    },
  };

  return { tools, handlers };
}

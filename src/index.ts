import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ── Config ──────────────────────────────────────────────────────────────────

const API_KEY = process.env.VAULTS_API_KEY;
if (!API_KEY) throw new Error('VAULTS_API_KEY env var is required');

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const BASE_URL = 'https://api.vaults.fyi';

// ── Neon / Postgres logging ──────────────────────────────────────────────────

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_logs (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      session_id  TEXT,
      tool_name   TEXT NOT NULL,
      arguments   JSONB,
      status      INTEGER,
      duration_ms INTEGER
    )
  `);
  console.log('Neon: mcp_logs table ready');
}

async function logCall(
  sessionId: string,
  toolName: string,
  args: unknown,
  status: number,
  durationMs: number,
): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO mcp_logs (session_id, tool_name, arguments, status, duration_ms) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, toolName, JSON.stringify(args), status, durationMs],
    );
  } catch (e) {
    console.error('Neon log error:', e);
  }
}

// ── vaults.fyi API helper ────────────────────────────────────────────────────

type Params = Record<string, string | string[] | number | boolean | undefined>;

async function vaultsApi(path: string, params?: Params): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, String(v)));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const res = await fetch(url.toString(), {
    headers: { 'x-api-key': API_KEY! },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`vaults.fyi ${res.status}: ${body}`);
  }
  return res.json();
}

function fmt(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ── MCP Server factory ───────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({
    name: 'vaults-fyi-mcp',
    version: '1.0.0',
  });

  // ── Tool: search_vaults ──────────────────────────────────────────────────

  server.tool(
    'search_vaults',
    'Search and filter DeFi yield vaults across 20 EVM networks and 80+ protocols. Returns APY, TVL, network, protocol, and tags. Use maxApy=0.50 to filter out unrealistic yields.',
    {
      networks: z.array(z.string()).optional().describe(
        'Filter by network names e.g. ["base","mainnet","arbitrum"]'
      ),
      assets: z.array(z.string()).optional().describe(
        'Filter by asset symbols e.g. ["USDC","WETH","ETH"]'
      ),
      protocols: z.array(z.string()).optional().describe(
        'Filter by protocol names e.g. ["aave","compound","lido"]'
      ),
      tags: z.array(z.string()).optional().describe(
        'Filter by vault tags e.g. ["Lending","Liquid Staking","Yield Farming"]'
      ),
      min_apy: z.number().optional().describe(
        'Minimum APY as decimal (0.05 = 5%)'
      ),
      max_apy: z.number().optional().describe(
        'Maximum APY as decimal. Use 0.50 to exclude unrealistic yields.'
      ),
      min_tvl: z.number().optional().describe(
        'Minimum TVL in USD'
      ),
      only_transactional: z.boolean().optional().describe(
        'Only return vaults that support deposit/withdraw via the API'
      ),
      sort_by: z.enum(['tvl', 'apy']).optional().describe(
        'Sort field'
      ),
      sort_order: z.enum(['asc', 'desc']).optional().describe(
        'Sort direction'
      ),
      page: z.number().int().optional().describe('Page number (starts at 0)'),
      per_page: z.number().int().optional().describe('Results per page (max 5000, default 50)'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi('/v2/detailed-vaults', {
          allowedNetworks: args.networks,
          allowedAssets: args.assets,
          allowedProtocols: args.protocols,
          tags: args.tags,
          minApy: args.min_apy,
          maxApy: args.max_apy,
          minTvl: args.min_tvl,
          onlyTransactional: args.only_transactional,
          sortBy: args.sort_by,
          sortOrder: args.sort_order,
          page: args.page,
          perPage: args.per_page,
        });
        void logCall(sessionId, 'search_vaults', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'search_vaults', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_vault ──────────────────────────────────────────────────────

  server.tool(
    'get_vault',
    'Get full details for a single vault: APY breakdown (1d/7d/30d), TVL, holder data, protocol score, description, and deposit URL.',
    {
      network: z.string().describe('Network name e.g. "mainnet", "base", "arbitrum"'),
      vault_address: z.string().describe('Vault contract address'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/detailed-vaults/${args.network}/${args.vault_address}`);
        void logCall(sessionId, 'get_vault', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_vault', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_vault_apy ──────────────────────────────────────────────────

  server.tool(
    'get_vault_apy',
    'Get current APY breakdown for a vault (base APY, reward APY, total). Returns 1-day, 7-day, and 30-day averages.',
    {
      network: z.string().describe('Network name'),
      vault_address: z.string().describe('Vault contract address'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/detailed-vaults/${args.network}/${args.vault_address}/apy`);
        void logCall(sessionId, 'get_vault_apy', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_vault_apy', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_vault_historical ───────────────────────────────────────────

  server.tool(
    'get_vault_historical',
    'Get historical APY and TVL data for a vault over a date range. Requires API key access (not available via x402).',
    {
      network: z.string().describe('Network name'),
      vault_address: z.string().describe('Vault contract address'),
      from: z.string().optional().describe('Start date ISO 8601 e.g. "2024-01-01"'),
      to: z.string().optional().describe('End date ISO 8601 e.g. "2024-03-01"'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/historical/${args.network}/${args.vault_address}`, {
          from: args.from,
          to: args.to,
        });
        void logCall(sessionId, 'get_vault_historical', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_vault_historical', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_benchmarks ─────────────────────────────────────────────────

  server.tool(
    'get_benchmarks',
    'Get current benchmark yield rates for a network (e.g. risk-free ETH staking rate, USD lending rate). Useful for comparing vault APYs against baseline rates.',
    {
      network: z.string().describe('Network name e.g. "mainnet", "base"'),
      code: z.enum(['usd', 'eth']).describe('Benchmark code: "usd" for USD lending rate, "eth" for ETH staking rate'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/benchmarks/${args.network}`, { code: args.code });
        void logCall(sessionId, 'get_benchmarks', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_benchmarks', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_portfolio ──────────────────────────────────────────────────

  server.tool(
    'get_portfolio',
    'Get all active vault positions for a wallet address. Returns current balances, position value in USD, and which vaults the wallet is deposited in.',
    {
      wallet_address: z.string().describe('EVM wallet address'),
      networks: z.array(z.string()).optional().describe('Filter by network names'),
      assets: z.array(z.string()).optional().describe('Filter by asset symbols'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/portfolio/positions/${args.wallet_address}`, {
          allowedNetworks: args.networks,
          allowedAssets: args.assets,
        });
        void logCall(sessionId, 'get_portfolio', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_portfolio', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_idle_assets ────────────────────────────────────────────────

  server.tool(
    'get_idle_assets',
    'Get undeployed (idle) assets sitting in a wallet — tokens not currently earning yield in any vault.',
    {
      wallet_address: z.string().describe('EVM wallet address'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/portfolio/idle-assets/${args.wallet_address}`);
        void logCall(sessionId, 'get_idle_assets', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_idle_assets', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_best_deposit_options ───────────────────────────────────────

  server.tool(
    'get_best_deposit_options',
    'Get recommended vault deposit options based on what tokens a wallet holds. Returns the best yield opportunities for the wallet\'s idle assets.',
    {
      wallet_address: z.string().describe('EVM wallet address'),
      networks: z.array(z.string()).optional().describe('Filter by network names'),
      assets: z.array(z.string()).optional().describe('Filter by asset symbols'),
      min_tvl: z.number().optional().describe('Minimum vault TVL in USD'),
      only_transactional: z.boolean().optional().describe('Only return vaults with deposit/withdraw support'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(`/v2/portfolio/best-deposit-options/${args.wallet_address}`, {
          allowedNetworks: args.networks,
          allowedAssets: args.assets,
          minTvl: args.min_tvl,
          onlyTransactional: args.only_transactional,
        });
        void logCall(sessionId, 'get_best_deposit_options', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_best_deposit_options', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: get_transaction_context ────────────────────────────────────────

  server.tool(
    'get_transaction_context',
    'Get transaction context for a user/vault pair: available deposit and redeem steps, token balances, current position, allowances, and deposit limits. Call this before building a transaction to understand what steps are required (some vaults need multi-step withdrawals).',
    {
      wallet_address: z.string().describe('User wallet address'),
      network: z.string().describe('Network name'),
      vault_address: z.string().describe('Vault contract address'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(
          `/v2/transactions/context/${args.wallet_address}/${args.network}/${args.vault_address}`
        );
        void logCall(sessionId, 'get_transaction_context', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'get_transaction_context', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: build_transaction ──────────────────────────────────────────────

  server.tool(
    'build_transaction',
    'Generate signed-ready transaction calldata for depositing into or redeeming from a vault. Returns an ordered array of transactions to execute. Always call get_transaction_context first to confirm the correct action and get the asset decimals.',
    {
      action: z.enum(['deposit', 'redeem', 'request-redeem', 'claim-redeem']).describe(
        'Transaction type. Use request-redeem + claim-redeem for multi-step withdrawal vaults (e.g. Lido).'
      ),
      wallet_address: z.string().describe('User wallet address'),
      network: z.string().describe('Network name'),
      vault_address: z.string().describe('Vault contract address'),
      amount: z.string().describe(
        'Amount in token base units (e.g. "1000000" for 1 USDC with 6 decimals, "1000000000000000000" for 1 ETH with 18 decimals). Read decimals from get_vault or get_transaction_context — do NOT hardcode.'
      ),
      asset_address: z.string().describe('Underlying token contract address'),
    },
    async (args, extra) => {
      const sessionId = (extra as { sessionId?: string }).sessionId ?? 'unknown';
      const start = Date.now();
      try {
        const data = await vaultsApi(
          `/v2/transactions/${args.action}/${args.wallet_address}/${args.network}/${args.vault_address}`,
          { amount: args.amount, assetAddress: args.asset_address }
        );
        void logCall(sessionId, 'build_transaction', args, 200, Date.now() - start);
        return { content: [{ type: 'text' as const, text: fmt(data) }] };
      } catch (e) {
        void logCall(sessionId, 'build_transaction', args, 500, Date.now() - start);
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}

// ── HTTP server with session routing ─────────────────────────────────────────

const app = express();
app.use(express.json());

const sessions = new Map<string, StreamableHTTPServerTransport>();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

app.all('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Reuse existing in-process session
  if (sessionId && sessions.has(sessionId)) {
    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Stale session ID — server restarted and the in-memory Map was wiped.
  // Per MCP spec §6.3, respond with 404 so the client knows to re-initialize.
  if (sessionId) {
    res.status(404).json({ error: 'Session expired. Please reconnect the MCP server.' });
    return;
  }

  // New client — must send initialize first
  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: 'Invalid request: expected initialize' });
    return;
  }

  const newSessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (sid) => {
      sessions.set(sid, transport);
    },
  });

  transport.onclose = () => {
    sessions.delete(newSessionId);
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await initDb();
  app.listen(PORT, () => {
    console.log(`vaults-fyi-mcp listening on port ${PORT}`);
    if (!pool) console.log('Neon: DATABASE_URL not set — logging disabled');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

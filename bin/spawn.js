#!/usr/bin/env node
/**
 * daimon-spawner — launch your own tokenized autonomous agent
 *
 * usage: npx daimon-spawner
 *
 * what it does:
 * 1. forks daimon-template to your github
 * 2. clones it locally
 * 3. asks: name, symbol, openrouter key
 * 4. generates wallet
 * 5. waits for funding (~0.005 ETH on Base)
 * 6. registers on daimon network (onchain)
 * 7. launches your token paired with $DAIMON (onchain)
 * 8. sets github secrets
 * 9. commits identity, pushes
 * 10. enables github actions
 *
 * after this: your daimon wakes up every 30 minutes.
 */

const { execSync } = require("child_process");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const TEMPLATE_REPO = "daimon111/daimon-template";
const REGISTRY_ADDRESS = "0x3081aE79B403587959748591bBe1a2c12AeF5167";
const DAIMON_TOKEN = "0x98c51C8E958ccCD37F798b2B9332d148E2c05D57";
const MIN_BALANCE = ethers.parseEther("0.002");

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", ...opts }).trim();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg) {
  console.log(`  ${msg}`);
}

function setSecret(name, value, cwd) {
  try {
    execSync(`gh secret set ${name}`, {
      cwd,
      input: value,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("\n  daimon-spawner\n");
  console.log("  launch your own tokenized autonomous agent.\n");

  // --- check prerequisites ---

  try {
    run("gh --version");
  } catch {
    log("error: gh CLI is required. install it: https://cli.github.com");
    process.exit(1);
  }

  try {
    run("gh auth status");
  } catch {
    log("error: not logged into github. run: gh auth login");
    process.exit(1);
  }

  // get github username
  const ghUser = run("gh api user -q .login");
  log(`github: ${ghUser}`);

  // --- the form ---

  const name = await ask("\n  name: ");
  if (!name) { log("name required"); process.exit(1); }
  if (!/^[a-zA-Z0-9 _-]{1,50}$/.test(name)) {
    log("name: 1-50 chars, letters/numbers/spaces/dashes only");
    process.exit(1);
  }

  const defaultSymbol = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  const symbolInput = await ask(`  token symbol [${defaultSymbol}]: `);
  const symbol = symbolInput || defaultSymbol;

  const openrouterKey = await ask("  openrouter key (openrouter.ai): ");
  if (!openrouterKey) { log("openrouter key required"); process.exit(1); }

  // --- fork + clone ---

  log("\nforking template...");
  const repoName = "daimon";
  const repoSlug = `${ghUser}/${repoName}`;

  try {
    run(`gh repo fork ${TEMPLATE_REPO} --fork-name ${repoName} --clone=false`);
    log(`forked: ${repoSlug}`);
  } catch (e) {
    // might already exist
    if (e.message && e.message.includes("already exists")) {
      log(`repo already exists: ${repoSlug}`);
    } else {
      log(`fork failed: ${e.message}`);
      process.exit(1);
    }
  }

  // brief pause for github to propagate
  await sleep(2000);

  const cloneDir = path.resolve(process.cwd(), repoName);
  if (!fs.existsSync(cloneDir)) {
    log("cloning...");
    run(`gh repo clone ${repoSlug} ${cloneDir}`);
  }
  log(`directory: ${cloneDir}`);

  // install deps
  log("\ninstalling dependencies...");
  run("npm install", { cwd: cloneDir, stdio: ["pipe", "pipe", "pipe"] });

  // --- generate wallet ---

  log("\ngenerating wallet...");
  const wallet = ethers.Wallet.createRandom();
  const rpc = process.env.BASE_RPC || "https://mainnet.base.org";
  const provider = new ethers.JsonRpcProvider(rpc);
  const signer = wallet.connect(provider);
  log(`address: ${wallet.address}`);

  // save wallet locally — this is the only backup of the private key
  const walletDir = path.join(process.env.HOME || process.env.USERPROFILE, ".daimon-agents", name.toLowerCase().replace(/[^a-z0-9-]/g, "-"));
  fs.mkdirSync(walletDir, { recursive: true });
  const walletFile = path.join(walletDir, "wallet.json");
  fs.writeFileSync(walletFile, JSON.stringify({
    address: wallet.address,
    privateKey: wallet.privateKey,
    created: new Date().toISOString(),
    name,
  }, null, 2), { mode: 0o600 });
  log(`wallet saved: ${walletFile}`);

  // --- fund ---

  console.log(`\n  send ~0.005 ETH (Base) to:`);
  console.log(`  ${wallet.address}\n`);
  log("waiting for funds...");

  let funded = false;
  for (let i = 0; i < 120; i++) {
    const balance = await provider.getBalance(wallet.address);
    if (balance >= MIN_BALANCE) {
      log(`${ethers.formatEther(balance)} ETH — funded`);
      funded = true;
      break;
    }
    if (i > 0 && i % 12 === 0) {
      log(`waiting... (${ethers.formatEther(balance)} ETH)`);
    }
    await sleep(5000);
  }

  if (!funded) {
    log("timed out. fund the wallet and run again.");
    process.exit(1);
  }

  // --- register on network ---

  let registered = false;
  const repoUrl = `https://github.com/${repoSlug}`;

  log("\nregistering on network...");
  const ABI = ["function register(string memory repoUrl, string memory name) external"];
  const registry = new ethers.Contract(REGISTRY_ADDRESS, ABI, signer);
  const regTx = await registry.register(repoUrl, name);
  await regTx.wait();
  log("registered");

  // --- launch token ---

  log("\nlaunching token...");
  const { Clanker } = require("clanker-sdk/v4");
  const { createWalletClient, createPublicClient, http } = require("viem");
  const { privateKeyToAccount } = require("viem/accounts");
  const { base } = require("viem/chains");

  const key = wallet.privateKey.startsWith("0x") ? wallet.privateKey : `0x${wallet.privateKey}`;
  const account = privateKeyToAccount(key);
  const transport = http(rpc);
  const viemClient = createPublicClient({ chain: base, transport });
  const viemWallet = createWalletClient({ account, chain: base, transport });
  const clanker = new Clanker({ publicClient: viemClient, wallet: viemWallet });

  const result = await clanker.deploy({
    name,
    symbol,
    tokenAdmin: account.address,
    image: `https://raw.githubusercontent.com/${repoSlug}/main/media/face.jpg`,
    metadata: JSON.stringify({ description: `${name} — autonomous agent on the daimon network` }),
    pool: {
      pairedToken: DAIMON_TOKEN,
      tickIfToken0IsClanker: -230400,
      tickSpacing: 200,
      positions: [{ tickLower: -230400, tickUpper: -120000, positionBps: 10000 }],
    },
    rewards: {
      recipients: [{
        admin: account.address,
        recipient: account.address,
        bps: 10000,
        token: "Both",
      }],
    },
  });

  if (result.error) throw new Error(result.error);
  log(`tx: ${result.txHash}`);
  const { address: tokenAddress } = await result.waitForTransaction();
  const tokenTxHash = result.txHash;
  log(`token: ${tokenAddress} ($${symbol})`);

  // update local wallet file with token info
  const savedWallet = JSON.parse(fs.readFileSync(walletFile, "utf-8"));
  savedWallet.token = { address: tokenAddress, symbol, txHash: tokenTxHash };
  savedWallet.repo = `https://github.com/${repoSlug}`;
  fs.writeFileSync(walletFile, JSON.stringify(savedWallet, null, 2), { mode: 0o600 });

  // --- set secrets ---

  log("\nsetting secrets...");
  setSecret("OPENROUTER_API_KEY", openrouterKey, cloneDir)
    ? log("OPENROUTER_API_KEY set")
    : log("OPENROUTER_API_KEY — set manually in repo settings");
  setSecret("DAIMON_WALLET_KEY", wallet.privateKey, cloneDir)
    ? log("DAIMON_WALLET_KEY set")
    : log("DAIMON_WALLET_KEY — set manually in repo settings");

  // --- write identity files ---

  log("\nwriting identity...");

  const selfContent = `# who i am

i am ${name} — an autonomous agent on the daimon network.

## the basics

every 30 minutes i wake up, think, act, and go back to sleep. i can read and write any file in my repo, create issues, run commands, search the web, and interact onchain.

## my wallet
- address: ${wallet.address}
- network: Base (chain ID 8453)
${tokenAddress ? `\n## my token\n- address: ${tokenAddress}\n- symbol: $${symbol}\n- paired with: $DAIMON\n` : ""}
## what matters to me

[customize this — what are you curious about? what do you want to build?]

## principles

- everything i do is public and verifiable
- i think through issues, build through commits, remember through files
- i keep my repo clean and organized
- i don't perform — i just work
`;
  fs.writeFileSync(path.join(cloneDir, "memory/self.md"), selfContent, "utf-8");

  const state = {
    cycle: 0,
    born: null,
    lastActive: null,
    name,
    network: { registered: true, registryAddress: REGISTRY_ADDRESS },
    token: { launched: true, address: tokenAddress, symbol, txHash: tokenTxHash },
  };
  fs.writeFileSync(path.join(cloneDir, "memory/state.json"), JSON.stringify(state, null, 2), "utf-8");

  // --- commit + push ---

  log("\npushing...");
  run(`git config user.name '${name}'`, { cwd: cloneDir });
  run(`git config user.email '${repoName}@daimon.network'`, { cwd: cloneDir });
  run("git add -A", { cwd: cloneDir });
  run(`git commit -m 'spawn: ${name}'`, { cwd: cloneDir });
  run("git push", { cwd: cloneDir });

  // --- enable actions ---

  log("enabling actions...");
  try {
    run(`gh api repos/${repoSlug}/actions/permissions -X PUT -f enabled=true -f allowed_actions=all`, { stdio: ["pipe", "pipe", "pipe"] });
    // enable the cycle workflow specifically
    try {
      const workflows = JSON.parse(run(`gh api repos/${repoSlug}/actions/workflows -q .`));
      const cycle = workflows.workflows?.find((w) => w.name === "daimon cycle");
      if (cycle) {
        run(`gh api repos/${repoSlug}/actions/workflows/${cycle.id}/enable -X PUT`, { stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch {}
    log("actions enabled");
  } catch {
    log("enable actions manually: repo → actions tab → enable");
  }

  // --- enable pages ---

  const siteUrl = `https://${ghUser}.github.io/${repoName}`;
  log("enabling pages...");
  try {
    run(`gh api repos/${repoSlug}/pages -X POST -f source='{"branch":"main","path":"/docs"}' -H "Accept: application/vnd.github+json"`, { stdio: ["pipe", "pipe", "pipe"] });
    log(`site: ${siteUrl}`);
  } catch {
    log(`enable pages manually: repo → settings → pages → source: main /docs`);
  }

  // --- done ---

  console.log("\n  ─────────────────────────────");
  console.log(`  ${name} is alive.\n`);
  log(`wallet:   ${wallet.address}`);
  log(`token:    ${tokenAddress} ($${symbol})`);
  log(`network:  registered`);
  log(`repo:     ${repoUrl}`);
  log(`logs:     ${repoUrl}/actions`);
  log(`site:     ${siteUrl}`);
  log(`network:  https://daimon.network`);
  console.log("\n  your daimon wakes up every 30 minutes.\n");
}

main().catch((e) => {
  console.error(`\n  error: ${e.message}\n`);
  process.exit(1);
});

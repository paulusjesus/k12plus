/**
 * K12Plus Scholarship Agent - Agentic Economy Prize integration (Circle).
 *
 * An autonomous reward agent for the K12Plus learning platform:
 * when a learner's Game Arcade points cross a milestone, the agent decides
 * a micro-scholarship amount and pays it in USDC from its own
 * Circle developer-controlled wallet, on chain.
 *
 * Chain: ARB-SEPOLIA (testnet). Explorer: https://sepolia.arbiscan.io
 *
 * Usage (Node 18+):
 *   npm install @circle-fin/developer-controlled-wallets
 *   export CIRCLE_API_KEY=...        (from console.circle.com, testnet key)
 *   export CIRCLE_ENTITY_SECRET=...  (registered in the Circle console)
 *   node scholarship-agent.js setup                # creates the agent's wallet, prints address
 *   node scholarship-agent.js pay <points> <recipient-address>
 *                                                  # agent decides and executes the payout
 *
 * No secrets live in this repository. The agent holds its own wallet;
 * the decision (whether and how much to pay) is made by the agent from
 * the learner's points, then executed on chain via Circle.
 */

const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets');

const BLOCKCHAIN = 'ARB-SEPOLIA';
const EXPLORER = 'https://sepolia.arbiscan.io/tx/';
// Native USDC token address on Arbitrum Sepolia
const USDC_TOKEN_ID_HINT = 'USDC';

function agentDecidePayout(points) {
  // The agent's reward policy: autonomous, deterministic and auditable.
  // 100+ points: 0.5 USDC micro-scholarship. 300+: 1 USDC. 1000+: 2 USDC.
  const p = parseInt(points, 10) || 0;
  if (p >= 1000) return '2';
  if (p >= 300) return '1';
  if (p >= 100) return '0.5';
  return null;
}

async function main() {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (cmd === 'gen-secret') {
    // generates and prints a new 32-byte entity secret; save it securely
    const { generateEntitySecret } = require('@circle-fin/developer-controlled-wallets');
    generateEntitySecret();
    return;
  }

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    console.error('Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET first.');
    process.exit(1);
  }

  if (cmd === 'register') {
    // registers the entity secret ciphertext with Circle and saves a recovery file
    const { registerEntitySecretCiphertext } = require('@circle-fin/developer-controlled-wallets');
    await registerEntitySecretCiphertext({ apiKey, entitySecret, recoveryFileDownloadPath: '.' });
    console.log('Entity secret registered. A recovery file was saved in this folder; keep it safe.');
    return;
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  if (cmd === 'setup') {
    const ws = await client.createWalletSet({ name: 'K12Plus Scholarship Agent' });
    const walletSetId = ws.data.walletSet.id;
    const w = await client.createWallets({
      walletSetId,
      blockchains: [BLOCKCHAIN],
      count: 1,
      accountType: 'SCA'
    });
    const wallet = w.data.wallets[0];
    console.log('Agent wallet created.');
    console.log('Wallet ID:      ', wallet.id);
    console.log('Wallet address: ', wallet.address);
    console.log('Blockchain:     ', wallet.blockchain);
    console.log('');
    console.log('Next: fund this address with testnet USDC at https://faucet.circle.com');
    console.log('Then: node scholarship-agent.js pay <points> <recipient-address>');
    return;
  }

  if (cmd === 'pay') {
    const points = arg1;
    let recipient = arg2;
    if (!points || !recipient) {
      console.error('Usage: node scholarship-agent.js pay <points> <recipient-address>');
      process.exit(1);
    }
    const amount = agentDecidePayout(points);
    if (!amount) {
      console.log('Agent decision: ' + points + ' points is below the 100-point milestone. No payout.');
      return;
    }
    console.log('Agent decision: ' + points + ' points earns a ' + amount + ' USDC micro-scholarship.');

    // find the agent's funded wallet (the one holding USDC)
    const wallets = await client.listWallets({ blockchain: BLOCKCHAIN });
    let wallet = null, usdc = null;
    for (const w of (wallets.data.wallets || [])) {
      const bal = await client.getWalletTokenBalance({ id: w.id });
      const tok = (bal.data.tokenBalances || []).find(t => (t.token.symbol || '').includes(USDC_TOKEN_ID_HINT) && parseFloat(t.amount) > 0);
      if (tok) { wallet = w; usdc = tok; break; }
    }
    if (!wallet) { console.error('No wallet with USDC found. Run setup, then fund the agent wallet at https://faucet.circle.com'); process.exit(1); }

    // 'demo' recipient: create a learner demo wallet to receive the scholarship
    if (recipient === 'demo') {
      const wsets = await client.listWalletSets();
      const wsId = wsets.data.walletSets[0].id;
      const lw = await client.createWallets({ walletSetId: wsId, blockchains: [BLOCKCHAIN], count: 1, accountType: 'SCA' });
      recipient = lw.data.wallets[0].address;
      console.log('Created learner demo wallet: ' + recipient);
    }

    const tx = await client.createTransaction({
      walletId: wallet.id,
      tokenId: usdc.token.id,
      destinationAddress: recipient,
      amount: [amount],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } }
    });
    const txId = tx.data.id;
    console.log('Transaction submitted, id: ' + txId);

    // poll until confirmed
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const st = await client.getTransaction({ id: txId });
      const t = st.data.transaction;
      console.log('State: ' + t.state + (t.txHash ? ('  txHash: ' + t.txHash) : ''));
      if (t.txHash && (t.state === 'CONFIRMED' || t.state === 'COMPLETE')) {
        console.log('');
        console.log('Agent wallet address: ' + wallet.address);
        console.log('Block explorer URL:   ' + EXPLORER + t.txHash);
        return;
      }
      if (t.state === 'FAILED' || t.state === 'DENIED') { console.error('Transaction failed.'); process.exit(1); }
    }
    console.log('Still pending. Check the Circle console for the transaction hash.');
    return;
  }

  console.error('Unknown command. Use: gen-secret | register | setup | pay <points> <recipient-address>');
}

main().catch(e => { console.error(e.response ? JSON.stringify(e.response.data, null, 2) : e); process.exit(1); });

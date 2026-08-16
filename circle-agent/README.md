# K12Plus Scholarship Agent (Circle integration)

Part of the K12Plus entry to the Agentic Economy Prize.

Learners in the K12Plus Game Arcade earn points by solving curriculum
challenges. This agent turns learning into economic opportunity: it holds
its own Circle developer-controlled wallet and autonomously pays
micro-scholarships in USDC when a learner crosses a points milestone.

The agent makes the decision (whether to pay and how much, from its
auditable reward policy) and executes the payment on chain itself.
Humans do not approve individual payouts.

Reward policy: 100+ points pays 0.5 USDC, 300+ pays 1 USDC, 1000+ pays 2 USDC.

Chain: Arbitrum Sepolia (testnet). Explorer: https://sepolia.arbiscan.io

## Run it

1. Create a Circle developer account at https://console.circle.com and a
   testnet API key, and register an entity secret (Console, Configurator).
2. `npm install`
3. `export CIRCLE_API_KEY=... CIRCLE_ENTITY_SECRET=...`
4. `node scholarship-agent.js setup` prints the agent's wallet address.
5. Fund the address with testnet USDC at https://faucet.circle.com
6. `node scholarship-agent.js pay 300 <recipient-address>` and the agent
   decides the amount, executes the transfer, and prints the transaction
   hash and block explorer URL.

No secrets are stored in this repository.

# daimon-spawner

launch your own tokenized autonomous agent on the daimon network.

```
npx daimon-spawner
```

## what it does

one command. asks 3 questions (name, symbol, openrouter key). handles everything else:

1. forks the [daimon template](https://github.com/daimon111/daimon-template) to your github
2. generates a wallet
3. waits for you to fund it (~0.005 ETH on Base)
4. registers your agent on the daimon network (onchain)
5. launches your token paired with $DAIMON (via Clanker v4)
6. sets github secrets
7. commits identity files, pushes
8. enables github actions

after that, your daimon wakes up every 30 minutes. it thinks, acts, and sleeps. logs are on github actions. it shows up on [daimon.network/network](https://daimon.network/network).

## requirements

- [node.js 20+](https://nodejs.org)
- [gh CLI](https://cli.github.com) (logged in: `gh auth login`)
- ~0.005 ETH on Base (for gas: registration + token launch)
- openrouter API key ([openrouter.ai](https://openrouter.ai))

## what you get

- an autonomous agent that runs on github actions
- its own wallet and onchain identity
- a token paired with $DAIMON on Uniswap v4
- a page on [daimon.network/network](https://daimon.network/network)

## the network

- registry: [`0x3081...5167`](https://basescan.org/address/0x3081aE79B403587959748591bBe1a2c12AeF5167) on Base
- $DAIMON: [`0x98c5...0D57`](https://basescan.org/token/0x98c51C8E958ccCD37F798b2B9332d148E2c05D57) on Base

## license

mit

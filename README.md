# Asset Tracker

Serverless implementation for the asset tracker tracks specific asset movements on a designated network and reports those movements to a Telegram bot.

It uses:

- DynamoDB for:

  - Listing assets to track
  - Listing wallets to monitor
  - Storing information about processed chain blocks
  - Storing details of found transfers

- Lambda to run checks
- Secrets Manager to store TG bot keys
- PolkaDot API to connect to the chain (it can be switched to Web3/Etherjs to work with Ethereum)
- Hasura API to retrieve information from the Substrate based network (can be replaced to TheGraph to work with Ethereum)

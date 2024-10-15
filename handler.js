import fetch from 'node-fetch'
import TelegramBot from 'node-telegram-bot-api'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb'

const REGION = 'us-east-1'
const GRAPHQL_ENDPOINT = process.env.GRAPHQL_ENDPOINT
const ROOT_RPC = process.env.ROOT_RPC

const LAST_PROCESSED_BLOCK_TABLE = process.env.LAST_PROCESSED_BLOCK_TABLE
const TRACKING_TABLE = process.env.TRACKING_TABLE
const TRANSFERS_TABLE = process.env.TRANSFERS_TABLE
const DEFAULT_LAST_PROCESSED_BLOCK = 15000000

const wsProvider = new WsProvider(ROOT_RPC)
const api = await ApiPromise.create({ provider: wsProvider })
const ddbClient = new DynamoDB({ region: REGION })
const ddb = DynamoDBDocument.from(ddbClient)

const init = async () => {
  // this implementation is chain ignorant, it will track all tokens and accounts,
  // but you can add a chain parameter to filter the results (e.g. chain:'7668' or chain:'0')
  // or token name, e.g. name:'ASTO' or name:'ROOT'

  let items = []

  try {
    const { Items } = await ddb.scan({ TableName: TRACKING_TABLE })
    items = Items
  } catch (error) {
    console.error('Error reading tracking data', error)
  }

  const wallets = items?.filter(i => i.type === 'wallet') || []
  const assets = items?.filter(i => i.type === 'asset') || []
  const tokens = Object.fromEntries(assets.map(({ id, name }) => [id, name]))
  const decimals = Object.fromEntries(
    assets.map(({ id, decimals }) => [id, decimals])
  )

  const TG_CREDENTIALS = JSON.parse(process.env.TG_CREDENTIALS)
  const TELEGRAM_BOT_TOKEN = TG_CREDENTIALS.tgToken
  const TELEGRAM_CHAT_ID = TG_CREDENTIALS.chatId
  const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN)

  return { wallets, assets, tokens, decimals, telegramBot }
}

const readBlock = async () => {
  try {
    const { Item } = await ddb.get({
      TableName: LAST_PROCESSED_BLOCK_TABLE,
      Key: { chain: 'root' }
    })
    return Item.block
  } catch (error) {
    console.error('Error reading last block:', error)
    return DEFAULT_LAST_PROCESSED_BLOCK
  }
}

const storeBlock = async block => {
  try {
    await ddb.put({
      TableName: LAST_PROCESSED_BLOCK_TABLE,
      Item: { chain: 'root', block }
    })
  } catch (error) {
    console.error('Error saving last block:', error)
  }
}

const storeTransfers = async items => {
  const putRequests = items.map(item => ({
    PutRequest: {
      Item: item
    }
  }))

  const params = {
    RequestItems: {
      [TRANSFERS_TABLE]: putRequests
    }
  }

  ddb.batchWrite(params, (err, data) => {
    if (err) {
      console.error('Error adding items:', JSON.stringify(err, null, 2))
    } else {
      console.log('Items added successfully:', JSON.stringify(data, null, 2))
    }
  })
}

// const findTransfers = async fromBlock => {
//   const lastHeader = await api.rpc.chain.getHeader()
//   const latestBlock = lastHeader.number.toNumber()
//   const batchSize = 100

//   let events = []

//   while (fromBlock < latestBlock) {
//     let trackedEvents = []
//     const promises = []
//     const toBlock = Math.min(fromBlock + batchSize, latestBlock)

//     try {
//       // Set the upper limit for the current batch

//       for (let i = fromBlock; i < toBlock; i++) {
//         // Fetch the block hash for the current block
//         const blockHash = await api.rpc.chain.getBlockHash(i)
//         const apiAt = await api.at(blockHash)

//         promises.push(
//           apiAt.query.system.events().then(events => {
//             events.map(({ event }) => {
//               if (event.section === 'balances' && event.method === 'Transfer') {
//                 const [from, to, value] = event.data
//                 trackedEvents.push({
//                   from: from.toString(),
//                   to: to.toString(),
//                   value: value.toString(),
//                   block: i
//                 })
//               }
//             })
//           })
//         )
//       }

//       // Wait for all promises in the current batch to resolve
//       await Promise.all(promises)
//     } catch (error) {
//       console.error('Error fetching events in batch:', error, fromBlock)
//     }

//     const foundEvents = trackedEvents.length
//       ? trackedEvents.filter(e => accounts.includes(e.from))
//       : []

//     events.push(...foundEvents)

//     // Move to the next batch
//     saveBlock(toBlock)
//     fromBlock += batchSize
//     console.log('Processed block:', fromBlock)
//   }
//   return events
// }

const fetchEvents = async (fromBlock, wallets, assets) => {
  // --------------------------------------------------------------------
  // HASURA query example to get token transfers from a specific account
  // --------------------------------------------------------------------

  // query TokenTransfersFrom {
  //   archive {
  //     event(
  //       where: {
  //         _and:
  //         	[
  //          		{ _or:
  //              	[
  //            			{args: {_contains: { from: "0x0000000210198695da702d62b08b0444f2233f9c"}}},
  //            			{args: {_contains: { from: "0xFffFfFff0000000000000000000000000000070B"}}},
  //            		]
  //            	},
  //           	{ _or:
  //             	[
  //                 { name: {_eq: "Balances.Transfer"}},         # ROOT Token Transfers
  //               	{ _and:
  //                 	[
  //                   	{name: {_eq: "Assets.Transferred"}},
  //                   	{ _or:
  //                     	[
  //                         {args:{_contains: {assetId: 2 }}} 		# XRP Token t
  //                         {args:{_contains: {assetId: 3 }}} 		# Vortex
  //                         {args:{_contains: {assetId: 1124 }}}  # Ethereum
  //                         {args:{_contains: {assetId: 2148 }}}	# Sylo
  //                         {args:{_contains: {assetId: 3172 }}}	# USDC
  //                         {args:{_contains: {assetId: 4196 }}}	# ASTO
  // 	                    ]
  //   	                }
  //     	            ]
  //       	        }
  //         	    ]
  //           	}
  //         	]
  //       	}
  //       order_by: {block_id: desc}
  //     ) {
  //       block_id
  //       name
  //       args
  //     }
  //   }
  // }

  const from = wallets
    .map(wallet => `{args: {_contains: {from: "${wallet.address}"}}}`)
    .join(',')

  const assetIds = assets
    .map(asset => `{args: {_contains: {assetId: ${asset.id}}}}`)
    .join(',')

  const startBlock = fromBlock.toString().padStart(10, '0')

  const query = `{
    archive {
      event(
        where: {_and: [
          { block_id: { _gt: "${startBlock}-00000"}}
          {_or: [${from}]}, 
          {_or: [
            {name: {_eq: "Balances.Transfer"}}, 
            {_and: [
              {name: {_eq: "Assets.Transferred"}}, 
              {_or: [${assetIds}]}
            ]}
          ]}
        ]}
        order_by: {block_id: desc}
      ) {
          id
          name
          args
        }
      }
    }`

  let json = {}

  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    })

    json = await response.json()
  } catch (error) {
    console.error('Error fetching events:', error)
    return []
  }

  const {
    data: { archive }
  } = json

  return archive?.event || []
}

export const handler = async event => {
  const msgs = []

  const fromBlock = await readBlock()
  const lastHeader = await api.rpc.chain.getHeader()
  const latestBlock = lastHeader.number.toNumber()

  const { wallets, assets, tokens, decimals, telegramBot } = await init()
  const events = await fetchEvents(fromBlock, wallets, assets)

  const items = events.map(
    ({ id, name, args: { to, from, amount, assetId } }) => {
      const token = assetId ? tokens[assetId] : 'ROOT'
      const block = id.split('-')[0]
      const precision = assetId ? 10 ** decimals[assetId] : 10 ** 6
      const normalizedAmount = (amount / precision).toString()
      msgs.push(
        `Token Transfer detected:\nBlock: ${block}\nFrom: ${from}\nTo: ${to}\nAsset: ${token}\nAmount: ${normalizedAmount}\n`
      )
      return { id, from, to, amount: normalizedAmount, token, block }
    }
  )

  // telegramBot.sendMessage(TELEGRAM_CHAT_ID, msgs.join('\n\n'))

  await storeTransfers(items)
  await storeBlock(latestBlock)

  return {
    statusCode: 200,
    body: events.length
      ? 'Token transfers detected. Check the DynamoDB.'
      : 'No new transfers.'
  }
}

import TelegramBot from 'node-telegram-bot-api'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb'
import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager'

const REGION = 'us-east-1'
const TELEGRAM_CHAT_ID = 0
const LAST_PROCESSED_BLOCK_TABLE = process.env.LAST_PROCESSED_BLOCK_TABLE
const TRACKING_TABLE = process.env.TRACKING_TABLE
const TRANSFERS_TABLE = process.env.TRANSFERS_TABLE
const DEFAULT_LAST_PROCESSED_BLOCK = 15000000
const TOKEN_ABI = [
  'event Transfer(address,address,uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 amount)'
]

const wsProvider = new WsProvider('wss://root.rootnet.live/archive/ws')
const ddbClient = new DynamoDB({ region: REGION })
const ddb = DynamoDBDocument.from(ddbClient)
const api = await ApiPromise.create({ provider: wsProvider })

let telegramBot, tokens, accounts

const initBot = async () => {
  const smClient = new SecretsManagerClient({ region: REGION })
  const SECRET_NAME = 'tgToken'
  try {
    const response = await smClient.send(
      new GetSecretValueCommand({
        SecretId: SECRET_NAME,
        VersionStage: 'AWSCURRENT' // VersionStage defaults to AWSCURRENT if unspecified
      })
    )
    const { TelegramBotToken } = JSON.parse(response.SecretString)
    telegramBot = new TelegramBot(TelegramBotToken)
  } catch (error) {
    // For a list of exceptions thrown, see
    // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
    throw error
  }
  // console.log({ bot })
}

const initTracking = async () => {
  // this implementation is chain ignorant, it will track all tokens and accounts,
  // but you can add a chain parameter to filter the results (e.g. chain:'7668' or chain:'0')
  // or token name, e.g. name:'ASTO' or name:'ROOT'

  try {
    accounts = await ddb.scan({ TableName: TRACKING_TABLE }).then(({ Items }) =>
      Items.map(i => {
        i.type === 'wallet' && i.address
      })
    )
  } catch (error) {
    console.error('Error reading accounts', error)
    accounts = ['0x0000000210198695da702d62b08b0444f2233f9c'] // for testing only
  }

  try {
    tokens = await ddb.scan({ TableName: TRACKING_TABLE }).then(({ Items }) =>
      Items.map(i => {
        i.type === 'token' && i.address
      })
    )
  } catch (error) {
    console.error('Error reading tokens', error)
    tokens = ['0xcCcCCccC00000001000000000000000000000000'] // ROOT, for testing only
  }
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

const saveBlock = async block => {
  try {
    await ddb.put({
      TableName: LAST_PROCESSED_BLOCK_TABLE,
      Item: { chain: 'root', block }
    })
  } catch (error) {
    console.error('Error saving last block:', error)
  }
}

const storeTransfer = async event =>
  ddb.put({
    TableName: TRANSFERS_TABLE,
    Item: {
      chain: 'root',
      from: event.from,
      to: event.to,
      value: event.value,
      block: event.block
    }
  })

const findTransfers = async fromBlock => {
  const lastHeader = await api.rpc.chain.getHeader()
  const latestBlock = lastHeader.number.toNumber()
  const batchSize = 100

  let events = []

  while (fromBlock < latestBlock) {
    let trackedEvents = []
    const promises = []
    const toBlock = Math.min(fromBlock + batchSize, latestBlock)

    try {
      // Set the upper limit for the current batch

      for (let i = fromBlock; i < toBlock; i++) {
        // Fetch the block hash for the current block
        const blockHash = await api.rpc.chain.getBlockHash(i)
        const apiAt = await api.at(blockHash)

        promises.push(
          apiAt.query.system.events().then(events => {
            events.map(({ event }) => {
              if (event.section === 'balances' && event.method === 'Transfer') {
                const [from, to, value] = event.data
                trackedEvents.push({
                  from: from.toString(),
                  to: to.toString(),
                  value: value.toString(),
                  block: i
                })
              }
            })
          })
        )
      }

      // Wait for all promises in the current batch to resolve
      await Promise.all(promises)
    } catch (error) {
      console.error('Error fetching events in batch:', error, fromBlock)
    }

    const foundEvents = trackedEvents.length
      ? trackedEvents.filter(e => accounts.includes(e.from))
      : []

    events.push(...foundEvents)

    // Move to the next batch
    saveBlock(toBlock)
    fromBlock += batchSize
    console.log('Processed block:', fromBlock)
  }
  return events
}

export const handler = async event => {
  // initBot()
  initTracking()

  const processedBlock = await readBlock()
  const events = await findTransfers(processedBlock)

  events.map(e => {
    const msg = `Token Transfer detected:\nFrom: ${e.from}\nTo: ${e.to}\nValue: ${e.value}`
    console.log({ msg })
    storeTransfer(e)
    // telegramBot.sendMessage(TELEGRAM_CHAT_ID, msg)
  })

  return {
    statusCode: 200,
    body: msgs.length ? msgs.join('\n') : 'No new transfers.'
  }
}

// --------------------------------------------------------------------
// HASURA query to get token transfers from a specific account
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

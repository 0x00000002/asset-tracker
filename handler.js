import fetch from 'node-fetch'
import TelegramBot from 'node-telegram-bot-api'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { DynamoDB } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb'

const REGION = process.env.REGION
const HASURA_ENDPOINT = process.env.HASURA_ENDPOINT
const ROOT_RPC = process.env.ROOT_RPC

const LAST_PROCESSED_BLOCK_TABLE = process.env.LAST_PROCESSED_BLOCK_TABLE
const TRACKING_TABLE = process.env.TRACKING_TABLE
const TRANSFERS_TABLE = process.env.TRANSFERS_TABLE
const TG_CREDENTIALS = JSON.parse(process.env.TG_CREDENTIALS)
const TELEGRAM_BOT_TOKEN = TG_CREDENTIALS.tgToken
const TELEGRAM_CHAT_ID = TG_CREDENTIALS.chatId

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
    }
  })
}

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
          extrinsic_id
        }
      }
    }`

  let json = {}

  try {
    const response = await fetch(HASURA_ENDPOINT, {
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
    ({ id, extrinsic_id, name, args: { to, from, amount, assetId } }) => {
      const token = assetId ? tokens[assetId] : 'ROOT'
      const fromAddr = from.slice(0, 8) + '...' + from.slice(-6)
      const toAddr = to.slice(0, 8) + '...' + to.slice(-6)
      const link = `https://explorer.rootnet.live/extrinsic/${extrinsic_id}`
      const precision = assetId ? 10 ** decimals[assetId] : 10 ** 6
      const normalizedAmount = (amount / precision).toString()
      const formattedAmount =
        Intl.NumberFormat('en-US').format(normalizedAmount)

      msgs.push(
        `💰 **${formattedAmount}** ${token}\n` +
          `👤 \`${fromAddr}\`\n` +
          `➡️ \`${toAddr}\`\n` +
          `🔎 [${extrinsic_id}](${link})`
      )
      return { id, from, to, amount: normalizedAmount, token }
    }
  )

  await storeTransfers(items)
  await storeBlock(latestBlock)

  if (msgs.length) {
    try {
      const header =
        '\n\n----------------------------------\n💸 Token Transfer(s) detected! 💸\n----------------------------------\n\n'
      await telegramBot.sendMessage(
        TELEGRAM_CHAT_ID,
        header + msgs.join('\n\n'),
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }
      )
    } catch (error) {
      console.error('Error sending Telegram message:', error)
    }
  }

  return {
    statusCode: 200,
    body: events.length
      ? 'Token transfers detected. Telegram messages sent, data stored'
      : 'No new transfers.'
  }
}

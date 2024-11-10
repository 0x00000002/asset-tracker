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
const TRANSFER_LIMIT = parseInt(process.env.TRANSFER_LIMIT)
const TG_CREDENTIALS = JSON.parse(process.env.TG_CREDENTIALS)
const TELEGRAM_BOT_TOKEN = TG_CREDENTIALS.tgToken
const TELEGRAM_CHAT_ID = TG_CREDENTIALS.chatId

const transferLimit = TRANSFER_LIMIT
const blocksProcessingLimit = 100000
const wsProvider = new WsProvider(ROOT_RPC)
const ddbClient = new DynamoDB({ region: REGION })
const ddb = DynamoDBDocument.from(ddbClient)

const init = async () => {
  // this implementation is chain ignorant, it will track all tokens and accounts,
  // but you can add a chain parameter to filter the results (e.g. chain:'7668' or chain:'0')
  // or token name, e.g. name:'ASTO' or name:'ROOT'

  let items = []

  const api = await ApiPromise.create({ provider: wsProvider })

  try {
    const { Items } = await ddb.scan({ TableName: TRACKING_TABLE })
    items = Items
  } catch (error) {
    console.error('Error reading tracking data', error)
  }

  const { wallets, futurePass, whitelist, tokens, decimals, assetIds } =
    items.reduce(
      (acc, { type, address, fp, id, name, decimals: d }) => {
        if (type === 'wallet') {
          acc.wallets.push(address?.toLowerCase())
          acc.futurePass[address.toLowerCase()] = fp?.toLowerCase()
        } else if (type === 'whitelist') {
          acc.whitelist.push(address?.toLowerCase())
        } else if (type === 'asset') {
          acc.assetIds.push(id)
          acc.tokens[id] = name
          acc.decimals[id] = d
        }
        return acc
      },
      {
        wallets: [],
        futurePass: {},
        whitelist: [],
        tokens: {},
        decimals: {},
        assetIds: []
      }
    )

  const tgBot = new TelegramBot(TELEGRAM_BOT_TOKEN)

  return {
    wallets,
    futurePass,
    whitelist,
    assetIds,
    tokens,
    decimals,
    tgBot,
    api
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
    return 14440000 // from Aug 1, 2024
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

const chunkArray = (array, chunkSize) => {
  const chunks = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

const storeTransfers = async items => {
  const itemChunks = chunkArray(items, 25)

  for (const chunk of itemChunks) {
    const putRequests = chunk.map(item => {
      return {
        PutRequest: {
          Item: item
        }
      }
    })

    const params = {
      RequestItems: {
        [TRANSFERS_TABLE]: putRequests
      }
    }

    try {
      await ddb.batchWrite(params)
    } catch (error) {
      console.error('Error adding items:', { error })
    }
  }
}

const fetchEvents = async ({
  startBlock,
  endBlock,
  wallets,
  whitelist,
  assetIds
}) => {
  const from = wallets.map(w => `{args: {_contains: {from: "${w}"}}}`).join('')

  const whitelisted = whitelist
    .map(w => `{args: {_contains: { to: "${w}"}}}`)
    .join('')

  // const ids = assetIds
  //   .map(id => `{args: {_contains: {assetId: ${id}}}}`)
  //   .join(',')

  const fromBlock = startBlock.toString().padStart(10, '0')
  const toBlock = endBlock.toString().padStart(10, '0')

  // to compare with an example, we don't check for other than ROOT transfers
  const query =
    '{ archive { event( where: {' +
    '_and: [' +
    `  { block_id: { _gt: "${fromBlock}"}}` +
    `  { block_id: { _lte: "${toBlock}"}}` +
    '  { name: { _eq: "Balances.Transfer"}}' +
    `  { _not: { _or: [${whitelisted}]}}` +
    `  { _or: [${from}]}` +
    ']} order_by: { block_id: desc })' +
    '{ id args }}}'

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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const sendMessagesTelegram = async (tgBot, msgs) => {
  if (msgs.length) {
    const header =
      '\n\n----------------------------------\n' +
      '💸 Token Transfer(s) detected! 💸\n' +
      '----------------------------------\n\n'

    try {
      await tgBot.sendMessage(TELEGRAM_CHAT_ID, header, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      })
    } catch (error) {
      console.error('Error sending Telegram message:', error)
    }

    const messageChunks = chunkArray(msgs, 25)

    try {
      for (const chunk of messageChunks) {
        await tgBot.sendMessage(TELEGRAM_CHAT_ID, chunk.join('\n\n'), {
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
        delay(1000)
      }
    } catch (error) {
      console.error('Error sending Telegram message:', error)
    }
  }
}

export const handler = async event => {
  const {
    wallets,
    futurePass,
    whitelist,
    assetIds,
    tokens,
    decimals,
    tgBot,
    api
  } = await init()

  const previouslyProcessedBlock = await readBlock()
  const lastHeader = await api.rpc.chain.getHeader()
  const lastBlockToProcess = lastHeader.number.toNumber()

  const msgs = []

  let startBlock = previouslyProcessedBlock + 1
  let endBlock = lastBlockToProcess

  do {
    endBlock = Math.min(startBlock + blocksProcessingLimit, lastBlockToProcess)

    const events = await fetchEvents({
      startBlock,
      endBlock,
      wallets,
      whitelist,
      assetIds
    })

    const items = events.flatMap(
      ({ id, name, args: { to, from, amount, assetId } }) => {
        const token = assetId ? tokens[assetId] : 'ROOT'
        const blockNumber = parseInt(id.split('-')[0])
        const link = `https://explorer.rootnet.live/block/${blockNumber}`
        const precision = assetId ? 10 ** decimals[assetId] : 10 ** 6
        const normalizedAmount = (amount / precision).toString()
        const formattedAmount =
          Intl.NumberFormat('en-US').format(normalizedAmount)

        const overThreshold = amount > transferLimit * precision
        const toDifferentUser = to !== futurePass[from]

        if (toDifferentUser && overThreshold) {
          msgs.push(
            `💰**${formattedAmount}** ${token}\n` +
              `👤\`${from}\`\n` +
              `➡️\`${to}\`\n` +
              `🔎[${id}](${link})`
          )
          return { id, from, to, amount: normalizedAmount, token }
        }
        return []
      }
    )

    startBlock = endBlock
    await storeTransfers(items)
    await storeBlock(lastBlockToProcess)
  } while (endBlock < lastBlockToProcess)

  await sendMessagesTelegram(tgBot, msgs)

  return {
    statusCode: 200,
    body: msgs.length
      ? 'Token transfers detected. Telegram messages sent, data stored'
      : 'No new transfers.'
  }
}

/** ----------------------------------------------------------------
  HASURA generic query example to get token transfers
  - with block number range
  - excluding whitelist accounts
  - from a specific account
  - for a specific tokens (except ROOT)
  - or for ROOT token transfers
--------------------------------------------------------------------

query TokenTransfersFrom {
   archive {
     event(
       where: {
         _and:
         	[
            { block_id: {_gte: "0010000000" }}
            { block_id: {_lt: "0014000000" }}
            {
              _not:
              { _or:
                [
                  {args: {_contains: { to: "0xffffffff0000000000000000000000000000070b"}}}
                  {args: {_contains: { to: "0xffffffff0000000000000000000000000000070b"}}}
                ]
              }
            }
          	{ _or:
              [
            		{args: {_contains: { from: "0x0000000210198695da702d62b08b0444f2233f9c"}}},
            		{args: {_contains: { from: "0xFffFfFff0000000000000000000000000000070B"}}},
            	]
            },
           	{ _or:
             	[
                 { name: {_eq: "Balances.Transfer"}},         # ROOT Token Transfers
               	{ _and:
                 	[
                   	{name: {_eq: "Assets.Transferred"}},
                   	{ _or:
                     	[
                         {args:{_contains: {assetId: 2 }}} 		# XRP Token t
                         {args:{_contains: {assetId: 3 }}} 		# Vortex
                         {args:{_contains: {assetId: 1124 }}}  # Ethereum
                         {args:{_contains: {assetId: 2148 }}}	# Sylo
                         {args:{_contains: {assetId: 3172 }}}	# USDC
                         {args:{_contains: {assetId: 4196 }}}	# ASTO
 	                    ]
   	                }
     	            ]
       	        }
         	    ]
           	}
         	]
       	}
       order_by: {block_id: desc}
     ) {
       id
       args
     }
   }
 }

 ----------------------------------------------------- */

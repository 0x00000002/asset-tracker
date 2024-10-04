import TelegramBot from 'node-telegram-bot-api'
import { ethers } from 'ethers'
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand
} from '@aws-sdk/client-ssm'

const ssmClient = new SSMClient({
  region: 'us-east-1'
})

import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager'

const secret_name = 'TGBot'
const customRpcUrl = 'https://root.rootnet.live'
const provider = new ethers.JsonRpcProvider(customRpcUrl)
const accounts = [
  '0xFffFfFff0000000000000000000000000000070B',
  '0x0000000210198695da702d62b08b0444f2233f9c'
]
const ROOT_TOKEN = '0xcCcCCccC00000001000000000000000000000000'
const ASTO_TOKEN = '0xCccCccCc00001064000000000000000000000000'
const transferEvent = 'event Transfer(address,address,uint256)'
// 'event Transfer(address indexed from, address indexed to, uint256 amount)'

const tokenABI = [
  // 'function balanceOf(address) external view returns (uint256)',
  // 'function transfer(address to, uint256 value) external returns (bool)',
  // 'function transferFrom(address from, address to, uint256 value) external returns (bool)',
  transferEvent
]
const root_ = new ethers.Contract(ROOT_TOKEN, tokenABI, provider)
const asto_ = new ethers.Contract(ASTO_TOKEN, tokenABI, provider)
const contracts = [root_]

let bot
let lastChecked

const initBot = async () => {
  const secret_name = 'tgToken'

  const client = new SecretsManagerClient({
    region: 'us-east-1'
  })

  let response

  try {
    response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: 'AWSCURRENT' // VersionStage defaults to AWSCURRENT if unspecified
      })
    )
  } catch (error) {
    // For a list of exceptions thrown, see
    // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
    throw error
  }

  const { TelegramBotToken } = JSON.parse(response.SecretString)
  bot = new TelegramBot(TelegramBotToken)
  // console.log({ bot })
}

const storeToSsm = async (name, value) => {
  const input = {
    Name: name,
    Value: value.toString(),
    Overwrite: true
  }

  try {
    const cmd = new PutParameterCommand(input)
    const response = await ssmClient.send(cmd)
  } catch (error) {
    console.error('Error storing parameter:', error)
    return null
  }
}

const readFromSsm = async name => {
  const input = {
    Name: name
  }
  const cmd = new GetParameterCommand(input)
  const response = await ssmClient.send(cmd)
  return Number(response.Parameter.Value)
}

const getTransferEvents = async (accounts, fromBlock, latest) => {
  try {
    const allEvents = []
    while (fromBlock < latest) {
      contracts.forEach(async contract => {
        accounts.forEach(async account => {
          // Define the filter for the Transfer event from the specific account
          const filter = contract.filters.Transfer(null, null)
          console.log({ filter })
          // Query the logs from the specified block to the latest block
          const events = await contract.queryFilter(
            filter,
            fromBlock,
            fromBlock + 1000
          )
          allEvents.push(...events)
        })
      })
      fromBlock += 1000
    }
    return allEvents
  } catch (error) {
    console.error('Error fetching events:', error)
    return []
  }
}

export const handler = async event => {
  initBot()
  storeToSsm('lastChecked', 15000000) // todo remove this line

  let msgs = []
  const latest = await provider.getBlockNumber()
  let lastChecked = Number(await readFromSsm('lastChecked'))
  const events = await getTransferEvents(accounts, lastChecked, latest)

  events.forEach(event => {
    const { from, to, value } = event.returnValues

    console.log({ from, to, value })

    if (accounts.includes(from) || accounts.includes(to)) {
      const message = `Token Transfer:\nFrom: ${from}\nTo: ${to}\nValue: ${value}`

      // Send Telegram notification
      // bot.sendMessage('YOUR_CHAT_ID', message)
      msgs.push(message)
    }
  })

  storeToSsm('lastChecked', latest)

  const body = msgs.length ? msgs.join('\n') : 'No new transfers.'

  return {
    statusCode: 200,
    body
  }
}

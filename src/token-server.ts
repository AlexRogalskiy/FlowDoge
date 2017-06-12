import { env } from "process"
import * as express from "express"
import fetch from "node-fetch"
import * as qs from "query-string"

if (!env.PORT) {
  throw new Error("no PORT environment variable found")
}
if (!env.CLIENT_SECRET) {
  throw new Error("no CLIENT_SECRET variable found ")
}
if (!env.CLIENT_ID) {
  throw new Error("no CLIENT_ID variable found ")
}
if (!env.REDIRECT_URI) {
  throw new Error("no REDIRECT_URI variable found ")
}

const app = express()

interface AccessToken {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

interface TokenRequest {
  /**
   * the unique token generated by the frontend for the authorization_code
   * grant as part of the oauth flow
   */
  state: string
  response: express.Response | null
  createdAt: number
  result: AccessToken | null
}

const tokenRequests: { [state: string]: TokenRequest } = {}

let numTokenRequests = 0

const MAX_REQUEST_LIFETIME = 1000 * 60 * 10 // ten minutes
const MAX_TOKEN_REQUESTS = 10000

let tokenRequestClearerInterval: NodeJS.Timer | null = null

function clearOldTokenRequests(threshold: number = MAX_REQUEST_LIFETIME): void {
  const now = Date.now()
  for (const state of Object.keys(tokenRequests)) {
    const request = tokenRequests[state]
    if (now - request.createdAt > threshold) {
      delete tokenRequests[state]
      numTokenRequests--
      if (request.response) {
        request.response.status(408)
        request.response.end()
      }
    }
  }
  if (numTokenRequests === 0 && tokenRequestClearerInterval !== null) {
    clearInterval(tokenRequestClearerInterval)
  }
}

function calculateMeanTokenRequestLifetime() {
  const now = Date.now()
  return Math.round(
    Object.keys(tokenRequests).reduce(
      (acc, k) => acc + (now - tokenRequests[k].createdAt),
      0,
    ) / numTokenRequests,
  )
}

function forceClearOldTokenRequests() {
  clearOldTokenRequests(calculateMeanTokenRequestLifetime())
}

function addTokenRequest(
  state: string,
  response: express.Response | null,
  result: AccessToken | null,
) {
  if (numTokenRequests >= MAX_TOKEN_REQUESTS) {
    clearOldTokenRequests()
    if (numTokenRequests >= MAX_TOKEN_REQUESTS) {
      forceClearOldTokenRequests()
    }
  }

  const req = {
    response,
    state,
    createdAt: Date.now(),
    result,
  }

  if (!(state in tokenRequests)) {
    numTokenRequests++
    tokenRequests[state] = req
  } else if (tokenRequests[state].result !== null && response !== null) {
    response.status(200)
    response.write(JSON.stringify(tokenRequests[state].result))
  } else {
    // replace old one
    tokenRequests[state] = req
  }

  if (tokenRequestClearerInterval === null) {
    tokenRequestClearerInterval = setInterval(
      clearOldTokenRequests,
      MAX_REQUEST_LIFETIME + 1000,
    )
  }
}

function handleAccessToken(state: string, token: AccessToken): void {
  const maybeTokenRequest = tokenRequests[state]

  if (maybeTokenRequest !== null && maybeTokenRequest.response !== null) {
    try {
      maybeTokenRequest.response.status(200)
      maybeTokenRequest.response.header("Content-type", "application/json")
      maybeTokenRequest.response.end(JSON.stringify(token))

      delete tokenRequests[state]
    } catch (_) {
      addTokenRequest(state, null, token)
    }
  } else {
    addTokenRequest(state, null, token)
  }
}

app.get("/token", (req, res) => {
  const { state } = req.query
  if (typeof state === "string" && state.match(/[a-z0-9]{32}/i)) {
    addTokenRequest(state, res, null)
  } else {
    /* tslint:disable-next-line */
    console.log("/token bad state", state)
    res.status(400)
    res.end()
  }
})

app.get("/login", (req, res) => {
  const { state, code } = req.query as {
    state: string | undefined
    code: string | undefined
  }

  if (!(typeof state === "string" && typeof code === "string")) {
    /* tslint:disable-next-line */
    console.log("/login bad params", req.params)
    res.status(400)
    res.end()
    return
  }

  /* tslint:disable-next-line */
  console.log("req", {
    client_id: env.CLIENT_ID,
    client_secret: env.CLIENT_SECRET,
    code,
    redirect_uri: env.REDIRECT_URI,
    grant_type: "authorization_code",
  })

  fetch("https://api.flowdock.com/oauth/token", {
    method: "POST",
    body: qs.stringify({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      code,
      redirect_uri: env.REDIRECT_URI,
      grant_type: "authorization_code",
    }),
    headers: {
      Accept: "application/json",
    },
  })
    .then(response => {
      if (response.status === 200) {
        response
          .text()
          .then(text => {
            /* tslint:disable-next-line */
            console.error(text)
            handleAccessToken(state, JSON.parse(text))
            res.end("Thanks for logging into Flowdoge. You can close this now.")
          })
          .catch(err => {
            /* tslint:disable-next-line */
            console.error(err)
            res.end("Couldn't parse response from Flowdock :/")
          })
      } else {
        res.end(
          "Errmmm, not sure what happened, but that didn't work. Maybe try again?",
        )
        response.text().then(text => {
          /* tslint:disable-next-line */
          console.log("bad response", response.status, text)
        })
      }
    })
    .catch(e => {
      /* tslint:disable-next-line */
      console.error(e)
    })
})

/* tslint:disable-next-line */
app.listen(env.PORT, () => console.log("got bound on port " + env.PORT))

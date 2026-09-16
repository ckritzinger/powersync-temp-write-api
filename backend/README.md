# Backend

## Overview

Node.js server application with HTTP endpoints to authorize a [PowerSync](https://www.powersync.com/) enabled application to sync data between a client device and a PostgreSQL, MySQL, MSSQL or MongoDB database.

The endpoints are as follows:

1. GET `/api/auth/token`

   - Returns a JWT access token used for PowerSync authentication.
   - Provide an optional `user_id` query parameter to set the subject of the JWT.

2. GET `/api/auth/keys`

   - JWKS endpoint used by the PowerSync service to validate JWTs.

3. POST `/api/data`

   - Accepts a batch of CRUD operations (PUT/PATCH/DELETE) from the client.

4. POST `/api/data/batch`

   - Accepts a **transaction batch** — an ordered run of whole transactions from the head of the client's upload queue — and applies each one in its own database transaction, in order.
   - Stops at the first failure. The response holds one result per transaction sent, in the same order and always the same length as the request, so the client never has to infer which transactions were applied. Transactions the batch never reached are reported as `not_attempted`.
   - Optional `on_fatal_error` in the request body: `stop` (the default) ends the batch at a fatal failure; `skip` drops that transaction and carries on, so a queue blocked by a poison operation can still drain. The skipped transaction's result still reports `fatal_error` with the error classification, so the client can record that it discarded the transaction.
   - `skip` applies to **fatal failures only**. A retryable failure always ends the batch.
   - The client may complete through the last result whose status is `success` or `fatal_error`. A `retryable_error` or `not_attempted` result is not completable.

### Error classification

Every failure is sorted into one of two kinds, in `src/persistance/classify-error.ts`:

- **retryable** — the environment misbehaved (deadlock, lock timeout, connection loss, resource exhaustion). The client uploads the transaction again after a delay.
- **fatal** — the data is wrong and can never be stored (missing required field, constraint violation, malformed or out-of-range value, schema mismatch). The client discards the transaction.

## Packages

[node-postgres](https://github.com/brianc/node-postgres) is used to interact with the Postgres database when a client performs requests to the `/api/data` endpoint.

[mongodb](https://www.npmjs.com/package/mongodb) is used to interact with the MongoDB database when a client performs requests to the `/api/data` endpoint.

[mysql2](https://www.npmjs.com/package/mysql2) is used to interact with the MySQL database when a client performs requests to the `/api/data` endpoint.

[node-mssql](https://www.npmjs.com/package/mssql) is used to connect to a MSSQL database to perform operations from the `/api/data` endpoint.

[jose](https://github.com/panva/jose) is used to sign the JWT which PowerSync uses for authorization.

## Requirements

Based on configuration, this app needs a Postgres, Mongo, MSSQL or MySQL instance. Easiest is probably to use docker containers for these databases.
Hosted free versions that can also be used:

1. Postgres: For a free version for testing/demo purposes, visit [Supabase](https://supabase.com/).

## Running the app

1. Clone the repository
2. Follow the steps outlined in [PowerSync Custom Authentication Example](https://github.com/journeyapps/powersync-jwks-example) → [Generate a key-pair](https://github.com/journeyapps/powersync-jwks-example#1-generate-a-key-pair) to get the keys you need for this app. This is an easy way to get started with this demo app. You can use your own public/private keys as well. Note: This backend will generate a temporary key pair for development purposes if the keys are not present in the `.env` file. This should not be used in production.
3. Create a new `.env` file in the root project directory and add the variables as defined in the `.env` file:

```shell
cp .env.template .env
```

4. Install dependancies

```shell
nvm use
```

```shell
pnpm install
```

## Start App

1. Run the following to start the application

```shell
pnpm start
```

This will start the app on `http://127.0.0.1:PORT`, where PORT is what you specify in your `.env` file.

2. Test if the app is working by opening `http://127.0.0.1:PORT/api/auth/token/` in the browser

3. You should get a JSON object as the response to that request

## Connecting the app with PowerSync

This process is only designed for demo/testing purposes, and is not intended for production use. You won't be using ngrok to host your application and database.

1. Download and install [ngrok](https://ngrok.com/)
2. Run the ngrok command to create a HTTPS tunnel to your local application

```shell
ngrok http 8000
```

This should create the tunnel and a new HTTPS URL should be availible e.g.

```shell
ngrok by @inconshreveable                                                                                                                  (Ctrl+C to quit)

Session Status                online
Account                       Michael Barnes (Plan: Free)
Update                        update available (version 2.3.41, Ctrl-U to update)
Version                       2.3.40
Region                        United States (us)
Web Interface                 http://127.0.0.1:4040
Forwarding                    http://your_id.ngrok-free.app -> http://localhost:8000
Forwarding                    https://your_id.ngrok-free.app -> http://localhost:8000

Connections                   ttl     opn     rt1     rt5     p50     p90
                              1957    0       0.04    0.03    0.01    89.93
```

3. Open the [PowerSync Dashboard](https://powersync.journeyapps.com/) and paste the `Forwarding` URL starting with HTTPS into the Credentials tab of your PowerSync instance e.g.

```
JWKS URI
https://your_id.ngrok-free.app/api/auth/keys/
```

Pay special attention to the URL, it should include the `/api/auth/keys/` path as this is used by the PowerSync server to validate tokens.

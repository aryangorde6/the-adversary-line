# Running the Tablekeeper stage-1 service

## Build and start — one copy-pasteable line

```sh
docker build -t tablekeeper . && docker run --rm -p 8080:8080 tablekeeper
```

Run it from this directory (`stage-1/`). Nothing else is needed: the image is
`node:22-alpine`, has zero runtime dependencies, is built without network access
and needs no volumes, no configuration and no manual steps.

The service is ready when

```sh
curl -s localhost:8080/health
```

answers `{"status":"ok"}`.

## Changing the port

`PORT` defaults to `8080`. To use another port, map the same value on both sides:

```sh
docker build -t tablekeeper . && docker run --rm -e PORT=9000 -p 9000:9000 tablekeeper
```

The process listens on `0.0.0.0` inside the container and makes no outbound
network connections at run time.

## Build only

```sh
docker build -t tablekeeper .
```

## Start only, against an image that already exists

```sh
docker run --rm -p 8080:8080 tablekeeper
```

## Run without Docker

```sh
npm start
```

## Own test suite

```sh
npm test
```

The suite boots the service in-process on an ephemeral port, so it needs no
container and no network. It prints one line per failed check and ends with
`checks=<n> passed=<n> failed=<n>`.

## What the image contains

`Dockerfile` copies `package.json` and `src/` only, then runs `node src/index.js`
as the non-root `node` user.
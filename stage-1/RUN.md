# Running the Tablekeeper stage-1 service

## Build

```sh
docker build -t tablekeeper .
```

The image is `node:22-alpine`, has no runtime dependencies and starts with
`node src/index.js`.

## Start

```sh
docker run --rm -p 8080:8080 tablekeeper
```

`PORT` defaults to `8080`; pass `-e PORT=9000 -p 9000:9000` to change it. The
service listens on `0.0.0.0` and needs no other setup, no volumes and no
outbound network access. It is ready when

```sh
curl -s localhost:8080/health
```

answers `{"status":"ok"}`.

## Run without Docker

```sh
npm start
```

## Own test suite

```sh
npm test
```

The suite boots the service in-process on an ephemeral port and needs no
container and no network.
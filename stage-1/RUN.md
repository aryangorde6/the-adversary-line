# Running the Tablekeeper reservations service

## Build and start

From the repository root — the folder that contains this `stage-1` folder — one
line builds the image and starts the service:

```sh
cd stage-1 && docker build -t tablekeeper . && docker run --rm -p 8080:8080 tablekeeper
```

That is the whole setup. No volumes, no configuration, no commands to run inside
the container, no compose file. If you are already inside `stage-1`, drop the
leading `cd stage-1 &&`.

The service prints a listening line and then serves requests. It keeps everything
in memory, so stopping the container throws its bookings away and the next start
begins empty.

## Checking it is up

In a second terminal:

```sh
curl -s localhost:8080/health
```

The answer is `{"status":"ok"}`. Give it a second or two after starting, and try
again once if the first attempt is refused.

If your machine has no `curl`, ask the running container itself:

```sh
docker run -d --name tablekeeper-check -p 8080:8080 tablekeeper
docker exec tablekeeper-check node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
docker rm -f tablekeeper-check
```

## Using a different port

`PORT` defaults to `8080` inside the container. To use another port, give the
same value to the environment and to both sides of the mapping:

```sh
cd stage-1 && docker build -t tablekeeper . && docker run --rm -e PORT=9000 -p 9000:9000 tablekeeper
```

Inside the container the process listens on `0.0.0.0` and opens no outbound
connections, so it runs perfectly well with no internet access at all.

## The same steps on their own

Build only:

```sh
cd stage-1 && docker build -t tablekeeper .
```

Start an image you have already built:

```sh
docker run --rm -p 8080:8080 tablekeeper
```

## Running it without Docker

Needs Node.js 22 or newer. From `stage-1`:

```sh
npm start
```

`PORT` is honoured here too, so `PORT=9000 npm start` listens on 9000.

## Own test suite

From `stage-1`, with Node.js 22 or newer. No container and no network:

```sh
npm test
```

It boots the service in-process on an ephemeral port. It prints one line per
failed check and ends with `checks=<n> passed=<n> failed=<n>`.

## What the image contains

`Dockerfile` copies `package.json` and `src/` and nothing else, then runs
`node src/index.js` as the non-root `node` user. The service has no runtime
dependencies, so the build installs no packages; the only thing it fetches is the
`node:22-alpine` base image.
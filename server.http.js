import * as net from "net";

class HTTPError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HTTPError";
    this.statusCode = statusCode;
  }
}

// the maximum length of an HTTP header
const kMaxHeaderLen = 1024 * 8;

// create a wrapper from net.Socket
function soInit(socket) {
  const conn = {
    socket,
    err: null,
    ended: false,
    reader: null,
  };
  socket.on("data", (data) => {
    console.assert(conn.reader);
    // pause the 'data' event until the next read.
    // it is used to implement backpressure.
    conn.socket.pause();
    // fulfill the promise of the current read.
    conn.reader.resolve(data);
    conn.reader = null;
  });
  socket.on("end", () => {
    // this also fulfills the current read.
    conn.ended = true;
    if (conn.reader) {
      conn.reader.resolve(Buffer.from("")); // EOF
      conn.reader = null;
    }
  });
  socket.on("error", (err) => {
    // errors are also delivered to the current read.
    conn.err = err;
    if (conn.reader) {
      conn.reader.reject(err);
      conn.reader = null;
    }
  });
  return conn;
}

// returns an empty `Buffer` after EOF.
function soRead(conn) {
  console.assert(!conn.reader); // no concurrent calls
  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }
    if (conn.ended) {
      resolve(Buffer.from("")); //EOF
      return;
    }
    // save the promise callbacks
    conn.reader = { resolve, reject };
    // and resume the 'data' event to fulfill the promise later.
    conn.socket.resume();
  });
}

function soWrite(conn, data) {
  console.assert(data.length > 0);
  return new Promise((resolve, reject) => {
    if (conn.err) {
      reject(conn.err);
      return;
    }

    conn.socket.write(data, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// echo server
async function serveClient(conn) {
  const buf = {
    data: Buffer.alloc(0),
    length: 0,
  };

  // server loop
  while (true) {
    // try to get 1 request header from the buffer
    const msg = cutMessage(buf);
    if (!msg) {
      // need more data
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0 && buf.length === 0) {
        return; // no more requests
      }
      if (data.length === 0) {
        return new HTTPError(400, "Unexpected EOF.");
      }
      // got some data, try it again.
      continue;
    }

    // process the message and send the response
    const body = readerFromReq(conn, buf, msg);
    const resp = handleReq(msg, body);
    await writeHTTPResp(conn, resp);
    // close the connection for HTTP/1.0
    if (msg.version === "1.0") {
      conn.socket.destroy();
      return;
    }
    // make sure that the request body is consumed completely
    while ((await body.read()).length > 0) {}
  }
}

async function newConn(socket) {
  console.log("connection:", socket.remoteAddress, socket.remotePort);
  const conn = soInit(socket);
  try {
    await serveClient(conn);
  } catch (exc) {
    console.error("exception:", exc);
    if (exc instanceof HTTPError) {
      const resp = {
        code: exc.code,
        headers: [],
        body: readerFromMemory(Buffer.from(exc.message + "\n")),
      };
      try {
        await writeHTTPResp(conn, resp);
      } catch (exc) {}
    }
  } finally {
    socket.destroy();
  }
}

function bufPush(buf, data) {
  const newLen = buf.length + data.length;
  if (buf.data.length < newLen) {
    // grow the capacity by the power of two
    let cap = Math.max(buf.data.length, 32);
    while (cap < newLen) {
      cap *= 2;
    }
    const growed = Buffer.alloc(cap);
    buf.data.copy(growed, 0, 0);
    buf.data = growed;
  }

  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

// parse & remove a message from the beginning of the buffer if possible
function cutMessage(buf) {
  // the end of the header is marked by '\r\n\r\n'
  const idx = buf.data.indexOf("\r\n\r\n");
  if (idx < 0 || idx + 4 > buf.length) {
    if (buf.length >= kMaxHeaderLen) {
      throw new HTTPError(413, "header is too large");
    }
    return null; // need more data
  }
  // parse & remove the header
  const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
  bufPop(buf, idx + 4);
  return msg;
}

function bufPop(buf, len) {
  buf.data.copyWithin(0, len, buf.len);
  buf.length -= len;
}

function parseHTTPReq(data) {
  // split the data into lines
  const lines = splitLines(data);
  // the first line is `METHOD URI VERSION`
  const [method, uri, version] = parseRequestLine(lines[0]);
  // followed by header fields in the format of `Name: value`
  const headers = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const h = Buffer.from(lines[i]); // copy
    if (!validateHeader(h)) {
      throw new HTTPError(400, "Bad field");
    }
    headers.push(h);
  }
  // the header ends by an empty line
  console.assert(lines[lines.length - 1].length === 0);
  return {
    method,
    uri,
    version,
    headers,
  };
}

function splitLines(data) {
  return data.split("\n");
}

function parseRequestLine(requestLine) {
  const [method, uri, version] = requestLine.split(" ");
  return [method, uri, version];
}

function validateHeader(header) {
  // Replace this with your validation logic based on RFC specifications
  // For example, you can check if the header follows the "Name: value" format
  const regex = /^[^:\s]+:\s*.+$/;
  return regex.test(header.toString());
}

// BodyReader from an HTTP request
function readerFromReq(conn, buf, req) {
  let bodyLen = -1;
  const contentLen = fieldGet(req.headers, "Content-Length");
  if (contentLen) {
    bodyLen = parseInt(contentLen.toString("latin1"), 10);
  }
  const bodyAllowed = req.method === "POST" || req.method === "PUT";
  const chunked =
    fieldGet(req.headers, "Transfer-Encoding")?.equals(
      Buffer.from("chunked")
    ) || false;
  if (!bodyAllowed && (bodyLen > 0 || chunked)) {
    throw new HTTPError(400, "HTTP body not allowed.");
  }
  if (!bodyAllowed) {
    bodyLen = 0;
  }

  if (bodyLen >= 0) {
    // "Content-Length" is present
    return readerFromConnLength(conn, buf, bodyLen);
  } else if (chunked) {
    // chunked encoding
    throw new HTTPError(501, "TODO");
  } else {
    // read the rest of the connection
    throw new HTTPError(501, "TODO");
  }
}

// BodyReader from a socket with a known length
function readerFromConnLength(conn, buf, remain) {
  return {
    length: remain,
    read: async () => {
      if (remain === 0) {
        return Buffer.from(""); // done
      }
      if (buf.length === 0) {
        // try to get some data if there is none
        const data = await soRead(conn);
        bufPush(buf, data);
        if (data.length === 0) {
          // expect more data!
          throw new Error("Unexpected EOF from HTTP body");
        }
      }
      // consume data from the buffer
      const consume = Math.min(buf.length, remain);
      remain -= consume;
      const data = Buffer.from(buf.data.subarray(0, consume));
      bufPop(buf, consume);
      return data;
    },
  };
}

// a sample request handler
async function handleReq(req, body) {
  // act on the request URI
  let resp;
  switch (req.uri.toString("latin1")) {
    case "/echo":
      // http echo server
      resp = body;
      break;
    default:
      resp = readerFromMemory(Buffer.from("hello world.\n"));
      break;
  }

  return {
    code: 200,
    headers: [Buffer.from("Server: my_first_http_server")],
    body: resp,
  };
}

// BodyReader from in-memory data
function readerFromMemory(data) {
  let done = false;
  return {
    length: data.length,
    read: async () => {
      if (done) {
        return Buffer.from(""); // no more data
      } else {
        done = true;
        return data;
      }
    },
  };
}

// send an HTTP respsonse through the socket
async function writeHTTPResp(conn, resp) {
  if (resp.body.length < 0) {
    throw new Error("TODO: chunked encoding");
  }
  // set the "Content-Length" field
  console.assert(!fieldGet(resp.headers, "Content-Length"));
  resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
  // write the header
  await soWrite(conn, encodeHTTPResp(resp));
  // write the body
  while (true) {
    const data = await resp.body.read();
    if (data.length === 0) {
      break;
    }
    await soWrite(conn, data);
  }
}

let server = net.createServer({ pauseOnConnect: true }); // open tcp con
server.on("connection", newConn);
server.on("error", (err) => {
  throw err;
});
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log("running on port 1234")
);

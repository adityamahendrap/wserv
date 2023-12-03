import * as net from "net";

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
async function serveClient(socket) {
  const conn = soInit(socket);
  const buf = {
    data: Buffer.alloc(0),
    length: 0,
  };

  // server loop
  while (true) {
    // try to get 1 message from the buffer
    const msg = cutMessage(buf);
    if (!msg) {
      const data = await soRead(conn);
      bufPush(buf, data);
      // EOF?
      if (data.length === 0) {
        return;
      }
      // got some data, try it again.
      continue;
    }

    // process the message and send the response
    if (msg.equals(Buffer.from("quit\n"))) {
      await soWrite(conn, Buffer.from("Bye.\n"));
      socket.destroy();
      return;
    } else {
      const reply = Buffer.concat([Buffer.from("Echo: "), msg]);
      await soWrite(conn, reply);
    }
  }
}

async function newConn(socket) {
  console.log("connection:", socket.remoteAddress, socket.remotePort);
  try {
    await serveClient(socket);
  } catch (exc) {
    console.error("exception:", exc);
  } finally {
    socket.destroy();
  }
}

function soListen(socket) {
  const listener = {
    socket,
  };

  return listener;
}

function soAccept(listener) {
  return new Promise((resolve, reject) => {
    listener.socket.accept((err, conn) => {
      if (err) {
        reject(err);
      } else {
        resolve(conn);
      }
    });
  });
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
    buf.data.growed;
  }

  data.copy(buf.data, buf.length, 0);
  buf.length = newLen;
}

// parse & remove a message from the beginning of the buffer if possible
function cutMessage(buf) {
  // messages are separated by '\n'
  const idx = buf.data.indexOf("\n");
  if (idx < 0 || idx > buf.length) {
    return null; // not complete
  }
  // make a copy of the message and move the remaining data to the front
  const msg = Buffer.from(buf.data.subarray(0, idx + 1));
  bufPop(buf, idx + 1);
  return msg;
}

function bufPop(buf, len) {
  buf.data.copyWithin(0, len, buf.len);
  buf.length -= len;
}

let server = net.createServer({ pauseOnConnect: true }); // open tcp con
server.on("connection", newConn);
server.on("error", (err) => {
  throw err;
});
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log("running on port 1234")
);

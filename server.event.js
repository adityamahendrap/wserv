import * as net from "net";

const newConn = (socket) => {
  console.log("connection:", socket.remoteAddress, socket.remotePort);
  // FIN received. The connection will be closed automatically.
  socket.on("end", () => console.log("eof"));
  socket.on("data", (data) => {
    console.log("data:", data);
    socket.write(data); // echo back the data.

    // actively closed the connection if the data contains 'q'
    if (data.includes("q")) {
      socket.end(); // this will send FIN and close the connection.
    }
  });
};

let server = net.createServer(); // open tcp con
server.on("connection", newConn);
server.on("error", (err) => {
  throw err;
});
server.listen({ host: "127.0.0.1", port: 1234 }, () =>
  console.log("running on port 1234")
);

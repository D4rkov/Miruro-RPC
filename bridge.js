const WebSocket = require("ws");
const PORT = 3847;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Set();
const DEBUG = false;

console.log(`Bridge listening on ws://127.0.0.1:${PORT}`);

wss.on("connection", (ws) => {
    clients.add(ws);

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            if (DEBUG)
                console.log(`[${ws.client ?? "Unknown"}]`, data);

            if (data.type === "hello") {
                ws.client = data.client;
                console.log(`${ws.client} connected.`);
                return;
            }

            // Relay to every other connected client
            for (const client of clients) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify(data));
                }
            }
        } catch (err) {
            console.error("Failed to process message:", err);
        }
    });

    ws.on("close", () => {
        console.log(`${ws.client ?? "Unknown"} disconnected.`);
        clients.delete(ws);
    });

    ws.on("error", (err) => {
        console.error("Client error:", err.message);
    });
});
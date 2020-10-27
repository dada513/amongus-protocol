import {
    AmongusClient,
    MasterServers,
    MapID
} from "../index.js"

const client = new AmongusClient({
    debug: true
});

await client.connect(MasterServers.EU[0][0], MasterServers.EU[0][1], "weakeyes");

const games = await client.search([MapID.TheSkeld]);

console.log(games);
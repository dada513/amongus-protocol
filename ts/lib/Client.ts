import { ClientOptions } from "./interfaces/ClientOptions.js"
import { BufferReader } from "./util/BufferReader.js"

import { parsePacket } from "./Parser.js"
import { composePacket } from "./Compose.js"

import dgram from "dgram"
import util from "util"
import { EventEmitter } from "events"
import { Packet, Payload, PayloadPacket, PlayerVoteAreaFlags } from "./interfaces/Packets.js"
import { DisconnectID, LanguageID, MapID, MessageID, PacketID, PayloadID, RPCID, SpawnID } from "./constants/Enums.js"
import { DisconnectMessages } from "./constants/DisconnectMessages.js"
import { runInThisContext } from "vm"
import { Code2Int } from "./util/Codes.js"
import { Game } from "./struct/Game.js"
import { ppid } from "process"
import { bitfield } from "./interfaces/Types.js"
import { JoinOptions } from "./interfaces/JoinOptions.js"

import { Player } from "./struct/objects/Player.js"
import { GameData } from "./struct/objects/GameData.js"

import { Component } from "./struct/components/Component.js"
import { PlayerClient } from "./struct/PlayerClient.js"
import { PlayerControl } from "./struct/components/PlayerControl.js"
import { MeetingHud } from "./struct/components/MeetingHud.js"
import { LobbyBehaviour } from "./struct/objects/LobbyBehaviour.js"

export declare interface AmongusClient {
    on(event: "packet", listener: (packet: Packet) => void);
    off(event: "packet", listener: (packet: Packet) => void);
    on(event: "disconnect", listener: () => void);
    off(event: "disconnect", listener: () => void);
    on(event: "connected", listener: () => void);
    off(event: "connected", listener: () => void);
}

export type AnyObject = Player | GameData;

export class AmongusClient extends EventEmitter {
    options: ClientOptions;
    socket: dgram.Socket;
    ip: string;
    port: number;
    nonce: number;
    username: string;

    game: Game;
    clientid: number;

    constructor (options: ClientOptions = {}) {
        super();

        this.options = options;
        this.nonce = 1;

        this.game = null;
    }

    debug(...fmt) {
        if (this.options.debug) {
            console.log(...fmt);
        }
    }

    isMe(id: number) {
        if (this.clientid === id || (this.game.me.Player && this.game.me.Player.PlayerControl.playerId === id)) {
            return true;
        }

        return false;
    }

    _disconnect() {
        this.emit("disconnect");
        
        this.socket.removeAllListeners();

        this.socket = null;
        this.ip = null;
        this.port = null;

        this.nonce = 1;
    }

    async disconnect(reason?: number, message?: string) {
        if (reason) {
            if (reason === DisconnectID.Custom) {
                if (message) {
                    await this.send({
                        op: PacketID.Disconnect,
                        reason: reason,
                        message: message
                    });
                } else {
                    await this.send({
                        op: PacketID.Disconnect,
                        reason: reason
                    });
                }
            } else {
                await this.send({
                    op: PacketID.Disconnect,
                    reason: reason
                });
            }
        } else {
            await this.send({
                op: PacketID.Disconnect
            });
        }

        await this.awaitPacket(packet => packet.op === PacketID.Disconnect);

        this._disconnect();
    }
    
    _connect(ip: string, port: number) {
        this.socket = dgram.createSocket("udp4");
        this.ip = ip;
        this.port = port;
        
        this.nonce = 1;

        this.socket.on("message", async buffer => {
            const packet = parsePacket(buffer);

            if (packet.reliable) {
                await this.ack(packet.nonce);
            }

            if (packet.bound === "client") {
                this.debug("Recieved packet", buffer, util.inspect(packet, false, 10, true));

                switch (packet.op) {
                    case PacketID.Unreliable:
                    case PacketID.Reliable:
                        switch (packet.payloadid) {
                            case PayloadID.JoinGame:
                                switch (packet.error) {  // Couldn't get typings to work with if statements so I have to deal with switch/case..
                                    case false:
                                        if (packet.code === this.game.code) {
                                            const client = new PlayerClient(this, packet.clientid);

                                            this.game.clients.set(client.clientid, client);
                                            this.game.emit("playerJoin", client);
                                        }
                                        break;
                                }
                                break;
                            case PayloadID.StartGame:
                                if (packet.code === this.game.code) {
                                    this.game.emit("start");

                                    this.game.started = true;

                                    await this.send({
                                        op: PacketID.Reliable,
                                        payloadid: PayloadID.GameData,
                                        code: this.game.code,
                                        parts: [
                                            {
                                                type: MessageID.Ready,
                                                clientid: this.clientid
                                            }
                                        ]
                                    });
                                }
                                break;
                            case PayloadID.EndGame:
                                if (packet.code === this.game.code) {
                                    this.game.emit("finish");

                                    this.game.started = false;
                                }
                                break;
                            case PayloadID.RemovePlayer:
                                if (packet.code === this.game.code) {
                                    const client = this.game.clients.get(packet.clientid);
                                    
                                    if (client) {
                                        client.removed = true;

                                        this.game.clients.delete(packet.clientid);
                                        this.game.emit("playerLeave", client);
                                    }
                                }
                                break;
                            case PayloadID.JoinedGame:
                                this.game = new Game(this, packet.code, packet.hostid, [packet.clientid, ...packet.clients]);
                                this.clientid = packet.clientid;
                                break;
                            case PayloadID.KickPlayer:
                                if (packet.code === this.game.code) {
                                    const client = this.game.clients.get(packet.clientid);

                                    if (client) {
                                        client.emit("kicked", packet.banned);
                                    }
                                }
                                break;
                            case PayloadID.GameData:
                            case PayloadID.GameDataTo:
                                if (this.game.code === packet.code) {
                                    for (let i = 0; i < packet.parts.length; i++) {
                                        const part = packet.parts[i];

                                        switch (part.type) {
                                            case MessageID.Data:
                                                const component = this.game.netcomponents.get(part.netid);

                                                if (component) {
                                                    component.OnDeserialize(part.datalen, part.data);
                                                }
                                                break;
                                            case MessageID.RPC:
                                                switch (part.rpcid) {
                                                    case RPCID.SetInfected:
                                                        this.game.setImposters(part.infected);
                                                        break;
                                                    case RPCID.CompleteTask:
                                                        break;
                                                    case RPCID.MurderPlayer: {
                                                        const client = this.game.getPlayerByNetID(part.targetnetid);
                                                        const murderer = this.game.getPlayerByNetID(part.handlerid);
                                                        
                                                        if (client && murderer) {
                                                            client.dead = true;

                                                            this.game.emit("murder", murderer, client);
                                                            client.emit("murdered", murderer);
                                                            murderer.emit("murder", client);
                                                        }
                                                        break;
                                                    }
                                                    case RPCID.StartMeeting:
                                                        if (part.targetid === 0xFF) {
                                                            this.game.emit("meeting", true, null);
                                                        } else {
                                                            const target = this.game.getPlayer(part.targetid);

                                                            this.game.emit("meeting", false, target);
                                                        }
                                                        break;
                                                    case RPCID.SetStartCounter:
                                                        if (this.game.startCounterSeq === null || part.sequence > this.game.startCounterSeq) {
                                                            this.game.startCount = part.time;
                                                            this.game.emit("startCount", this.game.startCount);
                                                        }
                                                        break;
                                                    case RPCID.VotingComplete:
                                                        if (part.tie) {
                                                            this.game.emit("votingComplete", false, true, null);
                                                        } else if (part.exiled === 0xFF) {
                                                            this.game.emit("votingComplete", true, false, null);
                                                        } else {
                                                            this.game.emit("votingComplete", false, false, this.game.getPlayer(part.exiled));
                                                        }
                                                        break;
                                                    case RPCID.CastVote: {
                                                        const client = this.game.getPlayer(part.voterid);
                                                        const suspect = this.game.getPlayer(part.suspectid);

                                                        this.game.emit("vote", client, suspect);
                                                        client.emit("vote", suspect);
                                                        break;
                                                    }
                                                    case RPCID.SetTasks:
                                                        const client = this.game.getPlayer(part.playerid);

                                                        if (client) {
                                                            client._setTasks(part.tasks);
                                                        }
                                                        break;
                                                    case RPCID.UpdateGameData:
                                                        this.game.GameData.GameData.UpdatePlayers(part.players);
                                                        break;
                                                }
                                                break;
                                            case MessageID.Spawn:
                                                switch (part.spawnid) {
                                                    case SpawnID.ShipStatus:
                                                        // new ShipStatus(this, this.game, part.components);
                                                        break;
                                                    case SpawnID.MeetingHub:
                                                        // new MeetingHub(this, this.game, part.components);
                                                        break;
                                                    case SpawnID.LobbyBehaviour:
                                                        new LobbyBehaviour(this, this.game, part.components)
                                                        break;
                                                    case SpawnID.GameData:
                                                        new GameData(this, this.game, part.components);
                                                        break;
                                                    case SpawnID.Player:
                                                        const playerclient = this.game.clients.get(part.ownerid);

                                                        new Player(this, playerclient, part.components);
                                                        break;
                                                    case SpawnID.HeadQuarters:
                                                        // new HeadQuarters(this, this.game, part.components);
                                                        break;
                                                    case SpawnID.PlanetMap:
                                                        // new PlanetMap(this, this.game, part.components);
                                                        break;
                                                    case SpawnID.AprilShipStatus:
                                                        // new AprilShipStatus(this, this.game, part.components);
                                                        break;
                                                }
                                                break;
                                            case MessageID.Despawn:
                                                this.game.netcomponents.delete(part.netid);
                                                break;
                                        }
                                    }
                                }
                                break;
                        }
                        break;
                }
            }

            this.emit("packet", packet);
        });
    }

    async connect(ip: string, port: number, username: string): Promise<boolean|number> {
        if (this.socket) {
            await this.disconnect();
        }

        this._connect(ip, port);

        if (await this.hello(username)) {
            this.emit("connected");

            return true;
        }

        return false;
    }

    _send(buffer: Buffer): Promise<void> {
        return new Promise((resolve, reject) => {
            this.socket.send(buffer, this.port, this.ip, err => {
                if (err) return reject(err);

                resolve();
            });
        });
    }

    awaitPacket(filter: (packet: Packet) => boolean): Promise<Packet|null> {
        const _this = this;

        return new Promise((resolve, reject) => {
            function onPacket(packet) {
                if (filter(packet)) {
                    _this.off("disconnect", onDisconnect);
                    _this.off("packet", onPacket);

                    resolve(packet);
                }
            }

            function onDisconnect() {
                _this.off("disconnect", onDisconnect);
                _this.off("packet", onPacket);

                resolve(null);
            }

            this.on("packet", onPacket);
            this.on("disconnect", onDisconnect);
        });
    }

    async awaitPayload(filter: (payload: PayloadPacket) => boolean): Promise<PayloadPacket|null> {
        return await this.awaitPacket(packet => {
            return (packet.op === PacketID.Unreliable || packet.op === PacketID.Reliable)
                && packet.bound === "client"
                && filter(packet);
        }) as PayloadPacket;
    }

    async send(packet: Packet): Promise<boolean> {
        const nonce = this.nonce;

        switch (packet.op) {
            case PacketID.Reliable:
            case PacketID.Hello:
            case PacketID.Ping:
                packet.reliable = true;
                packet.nonce = nonce;
                this.nonce++;
                break;
        }
        
        const composed = composePacket(packet, "server");
        
        await this._send(composed);
        
        this.debug("Sent packet", composed);

        if (packet.reliable) {
            const interval = setInterval(() => {
                this._send(composed);
            }, this.options.ackInterval || 1500);

            this.debug("Awaiting acknowledege", nonce);

            const ack = await this.awaitPacket(packet => {
                return packet.op === PacketID.Acknowledge
                    && packet.nonce === nonce;
            });
            
            this.debug("Recieved acknowledege", nonce);

            clearInterval(interval);

            return ack !== null;
        } else {
            return true;
        }
    }

    async ack(nonce: number): Promise<void> { 
        await this.send({
            op: PacketID.Acknowledge,
            nonce
        });
    }

    async hello(username: string): Promise<boolean> {
        if (await this.send({
            op: PacketID.Hello,
            username: username
        })) {
            this.username = username;
            
            return true;
        }

        return false;
    }

    async join(code: string|number, options: JoinOptions = {}): Promise<Game> {
        if (typeof code === "string") {
            return this.join(Code2Int(code));
        }

        if (this.game) {
            throw new Error("Join Error: You are already in a game. Please leave or end your current game before playing another.");
        }

        await this.send({
            op: PacketID.Reliable,
            payloadid: PayloadID.JoinGame,
            code: code,
            mapOwnership: 0x07
        });

        const packet = await Promise.race([
            this.awaitPayload(p => p.payloadid === PayloadID.Redirect),
            this.awaitPayload(p => p.payloadid === PayloadID.JoinedGame),
            this.awaitPayload(p => p.payloadid === PayloadID.JoinGame)
        ]);

        if (packet && (packet.op === PacketID.Reliable || packet.op === PacketID.Unreliable)) {
            if (packet.payloadid === PayloadID.Redirect) {
                await this.disconnect();

                await this.connect(packet.ip, packet.port, this.username);

                return await this.join(code);
            } else if (packet.payloadid === PayloadID.JoinedGame) {
                if (options.doSpawn ?? true) {
                    await this.send({
                        op: PacketID.Reliable,
                        payloadid: PayloadID.GameData,
                        code: packet.code,
                        parts: [
                            {
                                type: MessageID.SceneChange,
                                clientid: packet.clientid,
                                location: "OnlineGame"
                            }
                        ]
                    });
                }

                return this.game;
            } else if (packet.payloadid === PayloadID.JoinGame) {
                if (packet.bound === "client" && packet.error) {
                    throw new Error("Join error: " + packet.reason + " (" + packet.message + ")");
                }
            }
        } else {
            return null;
        }
    }
    
    async search(maps: bitfield|MapID[] = 0, imposters: number = 0, language: LanguageID = LanguageID.Any) {
        if (Array.isArray(maps)) {
            return maps.reduce((val, map) => val + (1 << map), 0);
        }
        
        await this.send({
            op: PacketID.Reliable,
            payloadid: PayloadID.GetGameListV2,
            bound: "server",
            options: {
                mapID: maps,
                imposterCount: imposters,
                language
            }
        });
    }
}
import { AmongusClient } from "../../Client.js"

import { GameObject } from "./GameObject.js"

import { GameData as GameDataComponent } from "../components/GameData.js"
import { VoteBanSystem } from "../components/VoteBanSystem.js"

import {
    ColourID,
    HatID,
    MessageID,
    PacketID,
    PayloadID,
    RPCID,
    SpawnID
} from "../../constants/Enums.js"

import { ComponentData } from "../../interfaces/Packets.js"
import { Game } from "../Game.js"
import { Component } from "../components/Component.js"

export class GameData extends GameObject {
    spawnid: SpawnID.GameData;
    components: [GameDataComponent, VoteBanSystem];

    constructor (client: AmongusClient, parent: Game, components: ComponentData[]) {
        super(client, parent);

        this.components = [
            new GameDataComponent(client, components[0].netid, components[0].datalen, components[0].data),
            new VoteBanSystem(client, components[1].netid, components[1].datalen, components[1].data),
        ];
        
        if (parent instanceof GameObject) {
            parent.addChild(this);
        }
    }

    get GameData() {
        return this.components[0];
    }

    get VoteBanSystem() {
        return this.components[1];
    }
}
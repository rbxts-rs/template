import { Players } from "@rbxts/services";
import { makeHello } from "shared/module";

print(makeHello(`main.client.ts, as ${Players.LocalPlayer.Name}`));

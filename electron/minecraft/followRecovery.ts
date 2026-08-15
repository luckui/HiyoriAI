interface Position {
  x: number;
  y: number;
  z: number;
}

interface FollowRecoveryMovementInput {
  previousBotPosition: Position;
  currentBotPosition: Position;
  minimumBotMovement: number;
}

export function hasFollowRecoveryMovement(input: FollowRecoveryMovementInput): boolean {
  const dx = input.currentBotPosition.x - input.previousBotPosition.x;
  const dy = input.currentBotPosition.y - input.previousBotPosition.y;
  const dz = input.currentBotPosition.z - input.previousBotPosition.z;
  const botMovement = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return botMovement >= input.minimumBotMovement;
}

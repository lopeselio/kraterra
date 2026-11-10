import { config } from './config.ts';

// Basalt, the AI tank, is a sub-account of the contract whose only key is a function-call key for
// `play` and `mint_starter`: it signs its own draft picks and shots, and owns its own munition pack.
export const AI_ACCOUNT = `basalt.${config.contract}`;
export const AI_METHODS = ['play', 'mint_starter'];

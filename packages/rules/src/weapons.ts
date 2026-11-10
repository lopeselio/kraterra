// The munitions. Ids are stable small integers: they go into the draft pool the contract redraws,
// into NFT packs, and into the logs. Names and behaviours are Kraterra's own.

export type Behaviour =
  | 'blast'     // explodes on impact
  | 'spread'    // three shells fanned a few degrees apart
  | 'cluster'   // bursts into bomblets on impact
  | 'dig'       // tunnels on through the ground, then explodes
  | 'wall'      // raises a stone wall where it lands
  | 'mud'       // packs a ball of dirt where it lands
  | 'fire'      // flames run along the surface both ways
  | 'roll'      // rolls downhill, then explodes
  | 'skip'      // bounces off the ground twice, then explodes
  | 'rain';     // calls shells down from the sky above the impact

export interface Weapon {
  id: number;
  key: string;
  name: string;
  blurb: string;
  kind: Behaviour;
  /** blast radius in voxels */
  r: number;
  /** damage at the centre of the blast */
  dmg: number;
  /** muzzle speed in percent of the standard shell */
  speed: number;
  /** relative weight in the common draw (0 = only from NFT packs) */
  weight: number;
  rare?: boolean;
  /** hex colour for the shell and its card */
  color: string;
}

export const WEAPONS: Weapon[] = [
  { id: 0, key: 'pebble', name: 'Pebble', blurb: 'A small shell. Cheap, honest, accurate.', kind: 'blast', r: 3, dmg: 22, speed: 100, weight: 12, color: '#c9c2b0' },
  { id: 1, key: 'thumper', name: 'Thumper', blurb: 'The workhorse: a solid crater and a solid hit.', kind: 'blast', r: 5, dmg: 36, speed: 100, weight: 12, color: '#ffb84a' },
  { id: 2, key: 'crater', name: 'Crater Maker', blurb: 'A huge blast that scoops out the hillside.', kind: 'blast', r: 8, dmg: 52, speed: 95, weight: 5, color: '#ff6a3c' },
  { id: 3, key: 'trident', name: 'Trident', blurb: 'Three shells fanned 5° apart.', kind: 'spread', r: 3, dmg: 18, speed: 100, weight: 8, color: '#7ad7ff' },
  { id: 4, key: 'seedpod', name: 'Seedpod', blurb: 'Bursts into six bomblets where it lands.', kind: 'cluster', r: 3, dmg: 14, speed: 100, weight: 7, color: '#9dff6a' },
  { id: 5, key: 'mole', name: 'Mole', blurb: 'Burrows 22 voxels on through the ground, then pops.', kind: 'dig', r: 4, dmg: 30, speed: 100, weight: 7, color: '#b07a4a' },
  { id: 6, key: 'bulwark', name: 'Bulwark', blurb: 'Raises a stone wall where it lands. Cover, or a cage.', kind: 'wall', r: 2, dmg: 0, speed: 100, weight: 5, color: '#9aa3b5' },
  { id: 7, key: 'mudslinger', name: 'Mudslinger', blurb: 'Packs a ball of dirt where it lands. Bury them.', kind: 'mud', r: 7, dmg: 0, speed: 100, weight: 5, color: '#8a5a32' },
  { id: 8, key: 'wildfire', name: 'Wildfire', blurb: 'Flames run 14 voxels along the ground both ways.', kind: 'fire', r: 14, dmg: 34, speed: 100, weight: 6, color: '#ff8a1a' },
  { id: 9, key: 'tumbler', name: 'Tumbler', blurb: 'Lands, then rolls downhill until it hits something.', kind: 'roll', r: 5, dmg: 40, speed: 100, weight: 6, color: '#e0d050' },
  { id: 10, key: 'skimmer', name: 'Skimmer', blurb: 'Skips off the ground twice before it blows.', kind: 'skip', r: 4, dmg: 32, speed: 100, weight: 6, color: '#6affd8' },
  { id: 11, key: 'needle', name: 'Needle', blurb: 'Fast and flat, a small blast that hits hard.', kind: 'blast', r: 2, dmg: 46, speed: 135, weight: 5, color: '#ffffff' },
  // rare: only from munition packs (NEP-171 NFTs)
  { id: 12, key: 'starfall', name: 'Starfall', blurb: 'Calls five shells down from the sky above the impact.', kind: 'rain', r: 4, dmg: 20, speed: 100, weight: 0, rare: true, color: '#c89bff' },
  { id: 13, key: 'tidebreaker', name: 'Tidebreaker', blurb: 'The biggest blast in the arsenal.', kind: 'blast', r: 12, dmg: 70, speed: 90, weight: 0, rare: true, color: '#3d8bff' },
  { id: 14, key: 'auger', name: 'Auger', blurb: 'Bores 48 voxels through anything, then erupts.', kind: 'dig', r: 6, dmg: 48, speed: 100, weight: 0, rare: true, color: '#ff4fa3' },
];

/** The rare kinds, in pack order (a pack's `kind` 0..2 maps to these ids). */
export const RARE_IDS = [12, 13, 14];
export const weapon = (id: number): Weapon => WEAPONS[id] ?? WEAPONS[0];

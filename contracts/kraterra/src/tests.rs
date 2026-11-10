use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken};

const SALT: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

fn ctx(who: &str, seed_byte: u8) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("kraterra.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .random_seed([seed_byte; 32])
        .block_timestamp(1_000_000_000)
        .build());
}
fn ctx_yocto(who: &str) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("kraterra.testnet".parse().unwrap())
        .predecessor_account_id(who.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(1))
        .build());
}

fn contract() -> Kraterra {
    ctx("kraterra.testnet", 0);
    Kraterra::new("kraterra.testnet".parse().unwrap(), "ref.testnet".parse().unwrap())
}

fn seat(name: &str, account: Option<&str>, packs: Vec<String>) -> SeatIn {
    SeatIn { name: name.into(), account: account.map(|a| a.parse().unwrap()), packs }
}

/// Creates "m1" (alice vs a guest) and runs the VRF draw with an all-0xab block seed.
fn live_match(c: &mut Kraterra, alice_packs: Vec<String>) {
    ctx("ref.testnet", 0xab);
    let _ = c.create_match("m1".into(), sha_hex(SALT), vec![seat("Alice", Some("alice.testnet"), alice_packs), seat("Guest", None, vec![])], "friend".into());
    assert_eq!(c.get_match("m1".into()).unwrap().status, "drawing");
    ctx("kraterra.testnet", 0xab);
    let vrf = c.draw_vrf("m1".into());
    assert_eq!(vrf, "ab".repeat(32));
}

fn mv(seat: u8, text: &str) -> MoveIn {
    MoveIn { seat, text: text.into() }
}

/// A complete legal log: picks p0..p19 in order, then each seat fires its slots 0..9.
fn full_log() -> Vec<MoveIn> {
    let mut out: Vec<MoveIn> = (0..PICKS).map(|k| mv(seat_of_move(k), &format!("p{k}"))).collect();
    let mut next = [0usize, 0usize];
    for k in PICKS..PICKS + SHOTS {
        let s = seat_of_move(k);
        let slot = next[s as usize];
        next[s as usize] += 1;
        out.push(mv(s, &format!("s{slot},45,60,{}", if slot == 0 { -5 } else { 0 })));
    }
    out
}

// the same vector is in packages/rules/test/protocol.test.ts
#[test]
fn shared_vector() {
    ctx("x.testnet", 0);
    assert_eq!(sha_hex(SALT), "2a8abfa8cb9906290437854193ca6bca41d4d4e26d1d454bd66a35158095e737");
    let seed = seed_of(&"ab".repeat(32), SALT);
    assert_eq!(seed, "5645e850911ede5ff2a226e1003cb812230bbf89b02cc1d1aeb839faf2b77c49");
    assert_eq!(draw_pool(&seed), vec![3, 1, 0, 0, 0, 10, 10, 5, 0, 5, 1, 1, 7, 6, 6, 7, 6, 2, 7, 6]);
}

#[test]
fn parse_moves_canonically() {
    assert_eq!(parse_move("p0"), Some(Move::Pick(0)));
    assert_eq!(parse_move("p19"), Some(Move::Pick(19)));
    assert_eq!(parse_move("p07"), None);
    assert_eq!(parse_move("r2"), Some(Move::Rare(2)));
    assert_eq!(parse_move("s3,180,100,-40"), Some(Move::Shot { slot: 3, angle: 180, power: 100, mv: -40 }));
    assert_eq!(parse_move("s3,181,100,0"), None);
    assert_eq!(parse_move("s3,90,101,0"), None);
    assert_eq!(parse_move("s3,90,50,41"), None);
    assert_eq!(parse_move("s3,90,50,-0"), None);
    assert_eq!(parse_move("s3,090,50,0"), None);
    assert_eq!(parse_move("s3,90,50"), None);
    assert_eq!(parse_move("x1"), None);
    assert_eq!(rares_of(&[2, 0, 2, 9]), vec![12, 14]);
}

#[test]
fn full_match() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    let log = full_log();
    c.play("m1".into(), log[..25].to_vec());
    c.play("m1".into(), log[25..].to_vec());
    c.settle("m1".into(), SALT.into(), vec![120, 80]);
    let m = c.get_match("m1".into()).unwrap();
    assert_eq!(m.status, "settled");
    assert_eq!(m.winner, Some(0));
    assert_eq!(m.pool, vec![3, 1, 0, 0, 0, 10, 10, 5, 0, 5, 1, 1, 7, 6, 6, 7, 6, 2, 7, 6]);
    assert_eq!(m.seed.as_deref(), Some("5645e850911ede5ff2a226e1003cb812230bbf89b02cc1d1aeb839faf2b77c49"));
    let s = c.stats_of("alice.testnet".parse().unwrap());
    assert_eq!((s.matches, s.wins, s.best, s.damage), (1, 1, 120, 120));
    assert_eq!(c.leaderboard(5).len(), 1);
    assert_eq!(c.get_config().2, 1);
}

#[test]
#[should_panic(expected = "the salt doesn't match the commitment")]
fn forged_salt_rejected() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    c.play("m1".into(), full_log());
    c.settle("m1".into(), "ff".repeat(32), vec![1, 0]);
}

#[test]
#[should_panic(expected = "not that seat's turn")]
fn wrong_seat_order_rejected() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    c.play("m1".into(), vec![mv(1, "p0")]);
}

#[test]
#[should_panic(expected = "bad move format")]
fn bad_format_rejected() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    c.play("m1".into(), vec![mv(0, "p00")]);
}

#[test]
#[should_panic(expected = "the draft is not over")]
fn shot_during_draft_rejected() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    c.play("m1".into(), vec![mv(0, "s0,45,50,0")]);
}

#[test]
#[should_panic(expected = "the match isn't live")]
fn no_moves_before_the_draw() {
    let mut c = contract();
    ctx("ref.testnet", 1);
    let _ = c.create_match("m1".into(), sha_hex(SALT), vec![seat("A", None, vec![]), seat("B", None, vec![])], "ai".into());
    c.play("m1".into(), vec![mv(0, "p0")]);
}

#[test]
#[should_panic(expected = "bad log")]
fn duplicate_pick_caught_at_settle() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    let mut log = full_log();
    log[1] = mv(1, "p0");
    c.play("m1".into(), log);
    c.settle("m1".into(), SALT.into(), vec![1, 0]);
}

#[test]
#[should_panic(expected = "bad log")]
fn reused_slot_caught_at_settle() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    let mut log = full_log();
    log[22] = mv(seat_of_move(22), "s0,45,60,0"); // seat 1's slot 0 was fired at move 20
    c.play("m1".into(), log);
    c.settle("m1".into(), SALT.into(), vec![1, 0]);
}

#[test]
fn check_log_fuel_and_rares() {
    let pool: Vec<u8> = (0..20).map(|i| (i % 12) as u8).collect();
    let rares = vec![vec![12u8], vec![]];
    let mut moves: Vec<String> = vec!["r0".into()];
    moves.extend((1..PICKS).map(|k| format!("p{k}")));
    let inv = check_log(&pool, &rares, &moves).unwrap();
    assert_eq!(inv[0][0], 12);
    assert_eq!(inv[0].len(), 10);
    // seat 1 can't use seat 0's rare
    let mut bad = moves.clone();
    bad[1] = "r0".into();
    assert!(check_log(&pool, &rares, &bad).is_err());
    // fuel: 40 total per seat
    let mut fuel = moves.clone();
    fuel.push("s0,45,50,30".into()); // seat 1
    fuel.push("s0,45,50,0".into()); // seat 0
    fuel.push("s1,45,50,-10".into()); // seat 1: 40 used
    assert!(check_log(&pool, &rares, &fuel).is_ok());
    fuel.push("s1,45,50,0".into());
    fuel.push("s2,45,50,1".into()); // seat 1 out of fuel
    assert!(check_log(&pool, &rares, &fuel).unwrap_err().contains("out of fuel"));
}

#[test]
fn packs_draft_and_ownership() {
    let mut c = contract();
    ctx("alice.testnet", 7);
    let id = c.mint_starter();
    assert!(c.has_starter("alice.testnet".parse().unwrap()));
    let kind = 7 % 3;
    let tok = c.nft_token(id.clone()).unwrap();
    assert_eq!(tok.metadata.title.unwrap(), format!("{} pack", PACK_NAMES[kind]));
    assert!(tok.metadata.media.unwrap().starts_with("data:image/svg+xml"));
    live_match(&mut c, vec![id.clone()]);
    let m = c.get_match("m1".into()).unwrap();
    assert_eq!(m.seats[0].rares, vec![RARE_IDS[kind]]);
}

#[test]
#[should_panic(expected = "that pack isn't the seat's")]
fn packs_must_be_owned() {
    let mut c = contract();
    ctx("bob.testnet", 1);
    let id = c.mint_starter();
    live_match(&mut c, vec![id]);
}

#[test]
#[should_panic(expected = "you already have your starter pack")]
fn starter_once() {
    let mut c = contract();
    ctx("alice.testnet", 1);
    c.mint_starter();
    c.mint_starter();
}

#[test]
#[should_panic(expected = "only the referee or that seat's account")]
fn strangers_cannot_play() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("mallory.testnet", 1);
    c.play("m1".into(), vec![mv(0, "p0")]);
}

#[test]
fn seat_account_may_play_own_moves() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("alice.testnet", 1);
    c.play("m1".into(), vec![mv(0, "p3")]);
    assert_eq!(c.get_match("m1".into()).unwrap().moves, vec!["p3".to_string()]);
}

#[test]
fn resign_reveals_and_scores() {
    let mut c = contract();
    live_match(&mut c, vec![]);
    ctx("ref.testnet", 1);
    c.play("m1".into(), vec![mv(0, "p0"), mv(1, "p1")]);
    c.resign("m1".into(), 0, SALT.into());
    let m = c.get_match("m1".into()).unwrap();
    assert_eq!((m.status.as_str(), m.winner), ("resigned", Some(1)));
    assert!(m.seed.is_some());
    assert_eq!(m.pool.len(), 20);
    assert_eq!(c.stats_of("alice.testnet".parse().unwrap()).losses, 1);
}

#[test]
fn nft_transfer_moves_pack() {
    let mut c = contract();
    ctx("alice.testnet", 2);
    let id = c.mint_starter();
    ctx_yocto("alice.testnet");
    c.nft_transfer("bob.testnet".parse().unwrap(), id.clone(), None, None);
    assert_eq!(c.nft_token(id.clone()).unwrap().owner_id.as_str(), "bob.testnet");
    assert_eq!(c.nft_tokens_for_owner("bob.testnet".parse().unwrap(), None, None).len(), 1);
    assert_eq!(c.nft_supply_for_owner("alice.testnet".parse().unwrap()).0, 0);
    assert_eq!(c.nft_total_supply().0, 1);
}

#[test]
#[should_panic(expected = "only the owner")]
fn mint_pack_owner_only() {
    let mut c = contract();
    ctx("alice.testnet", 2);
    c.mint_pack("alice.testnet".parse().unwrap(), 1);
}

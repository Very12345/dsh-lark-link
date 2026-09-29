// Reaction receipts are a fixed STATE MACHINE, not decoration: inbound gets
// OnIt (收到，这就去办), a completed turn gets DONE, a failed turn gets ERROR.
// Every value must be a Feishu-valid emoji_type from the official reaction
// catalog (emojis-introduce, authoritative scrape verified live) — the API
// rejects anything else with 231001, and tenant custom emojis are not
// supported. Case sensitive: Fire is valid, FIRE is not.
// Harness-agnostic pure module.

/** All Feishu-valid emoji_type values (open.feishu.cn …/emojis-introduce). */
export const VALID_EMOJI_TYPES: ReadonlySet<string> = new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon",
	// The ONLY two values in the official catalog that start with a digit —
	// easy to overlook, and a configured pool using them used to be silently
	// dropped by the allow-list filter below.
	"2022",
	"18X",
]);

/**
 * Completion marker. Deliberately NOT used as the inbound receipt: the two
 * reactions mean different things (see {@link ReactionSet}).
 */
export const DONE_EMOJI = "DONE";

/** The three states a turn can be in, each mapped to ONE fixed reaction. */
export interface ReactionSet {
	/** Inbound receipt — "got it, working on it". */
	receipt: string;
	/** Turn / command completed successfully. */
	done: string;
	/** Turn failed before completing. */
	error: string;
}

/**
 * Fixed, state-mapped reactions — chosen for MEANING, not decoration:
 * `OnIt` = 收到，这就去办 · `DONE` = 完成 ✅ · `ERROR` = 失败 ❌.
 * Reactions can only use Feishu's BUILT-IN emoji catalog: the reaction API
 * rejects anything else with 231001 (tenant custom emojis are not supported),
 * so every value is validated against {@link VALID_EMOJI_TYPES}.
 */
export const DEFAULT_REACTIONS: ReactionSet = {
	receipt: "OnIt",
	done: DONE_EMOJI,
	error: "ERROR",
};

/**
 * Resolve the configured reactions into a usable set. Each field is normalized
 * (trim; strip stray brackets/quotes a text config assignment may leave) and
 * falls back to its default when it is not a valid catalog entry. Deterministic
 * by design — the same config always renders the same reaction, unlike the
 * random pool this replaces: the reaction is a STATEMENT about the turn.
 */
export function resolveReactions(
	configured?: Partial<ReactionSet>,
): ReactionSet {
	const pick = (value: string | undefined, fallback: string): string => {
		const cleaned = String(value ?? "")
			.replace(/[[\]"']/g, "")
			.trim();
		return cleaned !== "" && VALID_EMOJI_TYPES.has(cleaned) ? cleaned : fallback;
	};
	return {
		receipt: pick(configured?.receipt, DEFAULT_REACTIONS.receipt),
		done: pick(configured?.done, DEFAULT_REACTIONS.done),
		error: pick(configured?.error, DEFAULT_REACTIONS.error),
	};
}

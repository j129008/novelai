// prompt-recipes.js
// Curated prompt recipes for NovelAI V4.5 (Full model).
//
// PROMPT FORMAT PRIMER (V4.5)
// ─────────────────────────────────────────────────────────────────────────────
// Tag ordering (highest priority first):
//   1. Subject count/gender  (1girl, 2boys)
//   2. Named character       (asuka langley soryu, zero two \(darling in the franxx\))
//   3. Core subject tags     (appearance, clothing, expression)
//   4. Action / pose         (sitting, running, looking at viewer)
//   5. Setting / environment (outdoors, forest, rain, night)
//   6. Composition / framing (cowboy shot, close-up, from above)
//   7. Lighting / atmosphere (soft lighting, volumetric light, bokeh)
//   8. Style / medium        (watercolor, oil painting, sketch)
//
// Weight syntax:
//   {tag}      × 1.05   (slight emphasis)
//   {{tag}}    × 1.10   (moderate emphasis)
//   {{{tag}}}  × 1.16   (strong emphasis)
//   [tag]      ÷ 1.05   (slight de-emphasis)
//   [[tag]]    ÷ 1.10
//   1.5::tag:: exact numeric weight (V4+ only)
//   -1::tag::  negative weight / aggressive removal (V4.5+ only)
//
// V4.5 Full auto-prepends: "location, very aesthetic, masterpiece, no text"
// Do NOT include those in templates — they are added by the model automatically.
//
// Quality tags to use manually when you want explicit control:
//   best quality, amazing quality, great quality
//   very aesthetic (redundant with auto-prepend but harmless)
//
// Negative prompt shorthand (UC_PRESETS keys from app.js):
//   "heavy"       — most restrictive, clean output
//   "light"       — minimal restrictions
//   "human-focus" — adds anatomy checks
//   "none"        — empty UC
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const PROMPT_RECIPE_CATEGORIES = [
  { id: "romance",    label: "Romance / Intimacy" },
  { id: "action",     label: "Action / Battle" },
  { id: "daily",      label: "Daily Life / Slice of Life" },
  { id: "fantasy",    label: "Fantasy / Magic" },
  { id: "dark",       label: "Dark / Horror" },
  { id: "comedy",     label: "Comedy / Cute" },
  { id: "dramatic",   label: "Dramatic / Emotional" },
  { id: "nature",     label: "Nature / Landscape" },
  { id: "nsfw",       label: "NSFW" },
];

// Each recipe:
//   id           — kebab-case unique identifier
//   title        — short evocative title (3-5 words)
//   mood         — one sentence: what does this image feel like?
//   category     — one of the category ids above
//   template     — NovelAI V4.5 prompt with proper tag order
//                  Use {character} as a placeholder where a named character tag goes.
//                  Placeholders are replaced at generation time.
//   negative_hint — specific UC additions beyond whatever preset is active;
//                   empty string means "nothing extra needed"

const PROMPT_RECIPES = [

  // ── ROMANCE / INTIMACY ────────────────────────────────────────────────────

  {
    id: "romance-rainy-cafe",
    title: "Rainy Cafe Confession",
    mood: "Two people sitting too close together in a warm cafe while rain streaks the window — the moment right before the words come out.",
    category: "romance",
    template: "1boy, 1girl, {couple}, cafe, indoors, sitting across from each other, {eye contact}, hands almost touching on table, rain on window, soft warm lighting, steam from coffee cups, cozy atmosphere, blush, nervous expression, gentle smile, casual clothing, bokeh background, {romantic atmosphere}, close-up on faces, shallow depth of field",
    negative_hint: "third person, crowd, busy background",
  },
  {
    id: "romance-rooftop-sunset",
    title: "Rooftop at Golden Hour",
    mood: "A sunset confession on a school rooftop, hair catching the last light of the day.",
    category: "romance",
    template: "1girl, {character}, school uniform, rooftop, outdoors, sunset, golden hour, {{warm lighting}}, hair blowing in wind, flushed cheeks, looking back over shoulder, shy smile, city skyline background, lens flare, silhouette rim light, upper body, soft focus background",
    negative_hint: "multiple characters, crowd",
  },
  {
    id: "romance-forehead-kiss",
    title: "Forehead Kiss",
    mood: "Tender and quiet — the kind of affection that doesn't need words.",
    category: "romance",
    template: "1boy, 1girl, {couple}, forehead kiss, eyes closed, gentle expression, {soft lighting}, indoors, bedroom, lying down, hair spread on pillow, peaceful, intimate, warm color palette, close-up, shallow depth of field, soft bokeh",
    negative_hint: "explicit content, harsh lighting",
  },
  {
    id: "romance-umbrella-rain",
    title: "One Umbrella, Two People",
    mood: "They're sharing an umbrella that's too small — neither of them minds.",
    category: "romance",
    template: "1boy, 1girl, {couple}, outdoors, rain, sharing umbrella, standing close together, shoulder touching, looking at each other, {romantic atmosphere}, wet hair, school uniform, street, night, neon reflections on wet pavement, bokeh lights, medium shot",
    negative_hint: "",
  },
  {
    id: "romance-stargazing",
    title: "Midnight Stargazing",
    mood: "Lying side by side in a field, pointing at constellations, the whole world impossibly quiet.",
    category: "romance",
    template: "1boy, 1girl, {couple}, lying on grass, looking up at sky, {{starry sky}}, milky way, night, outdoors, field, hands close together, peaceful expression, casual clothing, from above shot, ambient starlight, cool blue atmosphere, wide shot",
    negative_hint: "clouds covering stars",
  },
  {
    id: "romance-hair-tuck",
    title: "Tucking Her Hair Back",
    mood: "A small gesture that means everything.",
    category: "romance",
    template: "1boy, 1girl, hand reaching toward face, {hair tuck}, gentle touch, close-up on faces, {eye contact}, soft smile, afternoon light through window, curtains, indoors, warm sunlight, [blush], tender expression, medium shot",
    negative_hint: "",
  },
  {
    id: "romance-dance",
    title: "Last Dance",
    mood: "A slow dance in an empty ballroom — music barely audible, no one else exists.",
    category: "romance",
    template: "1boy, 1girl, {couple}, slow dancing, ballroom, indoors, {{elegant}}, formal dress, suit, chandelier lighting, empty dance floor, golden light, eyes closed, cheek to cheek, soft glow, wide shot with depth",
    negative_hint: "crowd, busy background",
  },

  // ── ACTION / BATTLE ───────────────────────────────────────────────────────

  {
    id: "action-sword-clash",
    title: "Blade to Blade",
    mood: "Two fighters locked at the sword, sparks flying, the world frozen in a single explosive second.",
    category: "action",
    template: "1girl, {character}, {dynamic pose}, sword clash, {sparks}, battle, outdoors, ruins, dramatic lighting, motion blur on blades, {action lines}, determined expression, torn clothing, wind effect, dust particles, dramatic angle, from below, wide shot, {{action scene}}",
    negative_hint: "static pose, standing still",
  },
  {
    id: "action-rooftop-chase",
    title: "Rooftop Sprint",
    mood: "Full speed across city rooftops at night — coat trailing, city lights blurring below.",
    category: "action",
    template: "1girl, {character}, running, leaping between rooftops, night, city, neon lights below, {motion blur}, coat billowing, determined expression, urban environment, from behind angle, wide shot, {{dynamic}}, rain, wet rooftops, speed lines",
    negative_hint: "static, standing",
  },
  {
    id: "action-magic-burst",
    title: "Spell Release",
    mood: "The moment a mage releases everything — pure energy tearing through the air.",
    category: "action",
    template: "1girl, {character}, magic, {{energy blast}}, outstretched arms, {glowing eyes}, dramatic expression, robes, outdoor battlefield, debris flying, magic circle, {particle effects}, light rays, extreme contrast, from below angle, wide shot, epic scale",
    negative_hint: "dark, muddy colors",
  },
  {
    id: "action-fist-impact",
    title: "Impact",
    mood: "A punch so perfect it rewrites the scene — shockwave, dust ring, everything.",
    category: "action",
    template: "1boy, {character}, punch, {impact}, shockwave, {dust explosion}, action scene, battle, outdoor, wide stance, determined expression, torn clothes, {dynamic pose}, dramatic lighting, action lines, from side angle",
    negative_hint: "",
  },
  {
    id: "action-sniper-perch",
    title: "Overwatch",
    mood: "Calm before violence — a lone figure on a high ledge, scope to eye, waiting.",
    category: "action",
    template: "1girl, {character}, sniper rifle, prone position, rooftop, cityscape below, night, scope, tactical gear, {calm expression}, [motion], detailed equipment, cool blue lighting, wide shot from behind, depth of field on distant city",
    negative_hint: "",
  },
  {
    id: "action-aerial-dive",
    title: "Freefall Attack",
    mood: "Diving out of the sky like a comet, blade raised, enemy below has no idea.",
    category: "action",
    template: "1girl, {character}, diving from above, sword raised, {{dynamic}}, aerial shot, clouds, sky, {speed lines}, wind tearing at clothing, fierce expression, looking down, from above perspective, dramatic angle, bright sky background",
    negative_hint: "static, grounded",
  },

  // ── DAILY LIFE / SLICE OF LIFE ────────────────────────────────────────────

  {
    id: "daily-morning-light",
    title: "Golden Morning",
    mood: "She's barely awake, sitting by the window with tea, light catching the dust in the air.",
    category: "daily",
    template: "1girl, {character}, morning, indoors, sitting at window, {sunlight through window}, mug of tea, cozy, loose clothing, sleepy expression, {warm golden light}, dust particles in light, curtains, soft bokeh, close-up, calm atmosphere",
    negative_hint: "nighttime, dark",
  },
  {
    id: "daily-bookstore",
    title: "Lost in the Stacks",
    mood: "Absorbed in a book in the back corner of an old bookstore, completely at peace.",
    category: "daily",
    template: "1girl, {character}, reading, bookstore, indoors, surrounded by books, {soft ambient light}, glasses, casual clothing, absorbed expression, bookshelves in background, warm lighting, wooden interior, afternoon, close-up on face and book",
    negative_hint: "",
  },
  {
    id: "daily-cooking",
    title: "Sunday Cooking",
    mood: "Apron on, something on the stove, humming a song no one else knows.",
    category: "daily",
    template: "1girl, {character}, cooking, kitchen, indoors, apron, casual clothing, {warm kitchen lighting}, steam rising, smile, focused expression, wooden kitchen, vegetables on counter, afternoon light, medium shot",
    negative_hint: "",
  },
  {
    id: "daily-bicycle-summer",
    title: "Summer Ride",
    mood: "Coasting downhill with no hands, wind everywhere, not a care in the world.",
    category: "daily",
    template: "1girl, {character}, riding bicycle, outdoors, summer, {wind in hair}, school uniform, smile, eyes closed, downhill road, trees lining the path, {sunlight dappled through leaves}, motion blur, side view, warm summer light, carefree",
    negative_hint: "",
  },
  {
    id: "daily-sleeping-train",
    title: "Train Nap",
    mood: "Asleep against the window on a long train ride, the countryside blurring past.",
    category: "daily",
    template: "1girl, {character}, sleeping, train, indoors, head against window, {countryside passing outside}, soft natural light, casual clothing, peaceful expression, earbuds, {bokeh landscape background}, close-up, afternoon",
    negative_hint: "indoor darkness",
  },
  {
    id: "daily-festival",
    title: "Summer Festival",
    mood: "Yukata, paper lanterns, and the smell of yakitori — summer will end but not tonight.",
    category: "daily",
    template: "1girl, {character}, yukata, summer festival, outdoors, night, {lantern light}, fireworks in background, {warm amber light}, happy expression, hair ornament, crowd in background (soft focus), food stalls, traditional japanese festival, medium shot",
    negative_hint: "",
  },
  {
    id: "daily-rooftop-lunch",
    title: "Rooftop Lunch Break",
    mood: "Eating a bento alone on the rooftop, but not lonely — just enjoying the sky.",
    category: "daily",
    template: "1girl, {character}, rooftop, outdoors, lunch, bento box, school uniform, sitting on ground, {clear blue sky}, cumulus clouds, soft breeze in hair, [blush], content expression, wide shot, noon lighting",
    negative_hint: "",
  },

  // ── FANTASY / MAGIC ───────────────────────────────────────────────────────

  {
    id: "fantasy-forest-spirit",
    title: "Forest Spirit",
    mood: "Something ancient and gentle watches from between the trees — part of the forest, not afraid of it.",
    category: "fantasy",
    template: "1girl, {character}, forest, outdoors, {glowing}, nature magic, flowers in hair, ethereal dress, barefoot, moss covered ground, ancient trees, dappled light, {mystical atmosphere}, deer nearby, serene expression, forest spirit, wide shot",
    negative_hint: "dark, horror",
  },
  {
    id: "fantasy-dragon-rider",
    title: "Dragonback",
    mood: "Above the clouds on dragonback, the whole world reduced to light and wind.",
    category: "fantasy",
    template: "1girl, {character}, riding dragon, {above clouds}, sky, dramatic lighting, cape billowing, determined expression, fantasy armor, {{epic scale}}, sunlight breaking through clouds, from behind and below angle, wide establishing shot, dragons, fantasy world",
    negative_hint: "",
  },
  {
    id: "fantasy-ancient-library",
    title: "The Infinite Library",
    mood: "A library that goes on forever in every direction — and she knows every book in it.",
    category: "fantasy",
    template: "1girl, {character}, library, indoors, infinite bookshelves, {magical light}, floating books, robes, reading, {ethereal atmosphere}, warm candlelight, tall ceilings, ancient stone, ladders, spiral staircases, wide shot with depth, fantasy setting",
    negative_hint: "",
  },
  {
    id: "fantasy-ritual-circle",
    title: "Summoning Ritual",
    mood: "A magic circle blazes to life on the floor — something vast and old is being called.",
    category: "fantasy",
    template: "1girl, {character}, standing in magic circle, {glowing runes}, outstretched arms, ritual, dark room, {dramatic lighting from below}, robes, intense expression, {particle effects}, smoke, candles, stone floor, wide shot",
    negative_hint: "muddy, low contrast",
  },
  {
    id: "fantasy-ice-palace",
    title: "Throne of Ice",
    mood: "A queen of winter in her palace at the edge of the world, cold and magnificent.",
    category: "fantasy",
    template: "1girl, {character}, ice palace, throne, seated, {ice and snow}, silver crown, white dress, cold color palette, {blue light}, breath mist, crystal walls, elegant, regal expression, from below angle, wide shot",
    negative_hint: "warm colors, fire",
  },
  {
    id: "fantasy-market",
    title: "The Night Market",
    mood: "A floating city at night, market stalls selling things that don't exist anywhere else.",
    category: "fantasy",
    template: "1girl, {character}, fantasy market, night, outdoor market, exotic goods, lanterns, {warm street lighting}, curious expression, cloak, cobblestones, floating buildings in background, crowd (soft focus), wide establishing shot, fantasy city",
    negative_hint: "",
  },
  {
    id: "fantasy-ruins",
    title: "Reclaimed by Time",
    mood: "She stands in ruins swallowed by jungle — the old world is gone but she was there for it.",
    category: "fantasy",
    template: "1girl, {character}, ancient ruins, outdoors, jungle overgrowth, crumbling stone, {golden shaft of light}, moss, vines, exploring, thoughtful expression, adventurer outfit, wide shot, epic scale, atmospheric haze",
    negative_hint: "modern setting",
  },

  // ── DARK / HORROR ─────────────────────────────────────────────────────────

  {
    id: "dark-abandoned-hospital",
    title: "Ward Fourteen",
    mood: "She found the room at the end of the hall and now she cannot leave.",
    category: "dark",
    template: "1girl, {character}, abandoned hospital, indoors, {dark atmosphere}, torn hospital gown, pale skin, {empty eyes}, flickering fluorescent light, broken tiles, shadows, debris, [color], desaturated, cold lighting, from above angle, unsettling",
    negative_hint: "bright colors, cheerful",
  },
  {
    id: "dark-rain-alone",
    title: "Nobody Answered",
    mood: "Standing alone in the rain at 2AM, phone in hand, call unanswered.",
    category: "dark",
    template: "1girl, {character}, outdoors, night, rain, {wet}, standing alone, phone in hand, empty street, neon sign reflections, {cold blue lighting}, dejected expression, soaked clothing, looking down, medium shot, desaturated color palette",
    negative_hint: "",
  },
  {
    id: "dark-mirror-crack",
    title: "The Other One",
    mood: "The reflection in the broken mirror doesn't move when you do.",
    category: "dark",
    template: "1girl, {character}, broken mirror, {doppelganger}, horror, reflection with different expression, {unsettling}, dark room, single light source, cracked glass fragments, pale lighting, disturbing, surreal, close-up on mirror",
    negative_hint: "bright, cheerful",
  },
  {
    id: "dark-forest-fog",
    title: "Into the Fog",
    mood: "She keeps walking. Something in the fog matches her pace exactly.",
    category: "dark",
    template: "1girl, {character}, dark forest, night, {thick fog}, walking, from behind, dead trees, {eerie atmosphere}, pale moonlight, silhouette, slow horror, wide shot, [color], desaturated, atmospheric",
    negative_hint: "bright colors",
  },
  {
    id: "dark-throne-of-skulls",
    title: "Queen of Nothing",
    mood: "She built an empire out of everyone who doubted her.",
    category: "dark",
    template: "1girl, {character}, dark throne, {{dramatic}}, dark crown, gothic, chains, shadows, {dark atmosphere}, regal expression, torn dress, stone throne room, ravens, {{intense gaze}}, from below angle, wide shot, high contrast",
    negative_hint: "soft colors, cheerful",
  },
  {
    id: "dark-void",
    title: "The Unmaking",
    mood: "She is coming apart at the edges — and she is the only one who can see it.",
    category: "dark",
    template: "1girl, {character}, {dissolving}, {{particles}}, dark void, surreal, falling, glitch effect, dual exposure, {ethereal}, tears, reaching out, abstract background, {dramatic lighting}, conceptual art, [realistic]",
    negative_hint: "",
  },

  // ── COMEDY / CUTE ─────────────────────────────────────────────────────────

  {
    id: "comedy-cat-ears",
    title: "Definitely Not a Cat",
    mood: "She insists the cat ears are just a fashion choice. The tail is also just a fashion choice.",
    category: "comedy",
    template: "1girl, {character}, cat ears, cat tail, {{cute}}, :3, kawaii, casual clothing, indoors, holding a cat who also looks offended, {warm lighting}, chibi adjacent proportions, comedy, big eyes, flushed cheeks, hugging cat",
    negative_hint: "",
  },
  {
    id: "comedy-oversized-sweater",
    title: "Borrowed Sweater",
    mood: "The sweater goes down to her knees. She is very smug about this.",
    category: "comedy",
    template: "1girl, {character}, oversized sweater, {{cozy}}, sleeves covering hands, smug expression, :3, indoors, bedroom, morning, messy hair, sock feet, warm lighting, sitting on bed, close-up, cute, casual",
    negative_hint: "",
  },
  {
    id: "comedy-food-war",
    title: "This Bite Is Mine",
    mood: "Both chopsticks reached for the last piece at exactly the same time.",
    category: "comedy",
    template: "1boy, 1girl, {couple}, restaurant, {chopstick standoff}, competing over last bite of food, comedic expression, determination, blushing, table with food, indoors, warm restaurant lighting, medium shot, comedic",
    negative_hint: "",
  },
  {
    id: "comedy-trip-catch",
    title: "Obligatory Catch",
    mood: "She tripped on nothing. He caught her. She is choosing not to acknowledge this.",
    category: "comedy",
    template: "1boy, 1girl, {couple}, trip and catch, {{comedy}}, one person catching other, surprised expression, blushing, school hallway, indoors, afternoon, medium shot, embarrassed expression, [eye contact]",
    negative_hint: "",
  },
  {
    id: "comedy-neko-pile",
    title: "Cat Catastrophe",
    mood: "She sat down for one second and now there are seven cats on her. She has accepted this.",
    category: "comedy",
    template: "1girl, {character}, surrounded by cats, multiple cats, {{cute}}, sitting on floor, cats on lap, cats on head, cats on shoulders, amused expression, indoors, cozy, warm lighting, medium shot, comedy, kawaii",
    negative_hint: "",
  },
  {
    id: "comedy-study-fail",
    title: "Fell Asleep Studying",
    mood: "She was definitely studying. The drool on her textbook is part of the method.",
    category: "comedy",
    template: "1girl, {character}, sleeping at desk, {drooling}, textbook, pencil in hand, glasses askew, study room, night, desk lamp, scattered papers, {comedy}, peaceful sleeping expression, close-up",
    negative_hint: "",
  },

  // ── DRAMATIC / EMOTIONAL ──────────────────────────────────────────────────

  {
    id: "dramatic-goodbye-train",
    title: "Last Departure",
    mood: "The doors closed before she could say what she came to say.",
    category: "dramatic",
    template: "1girl, {character}, train station, {train departing}, hand raised against glass, {tears}, platform, alone, wind from departing train, hair blown, evening, warm station lights against cold outside, medium shot, deeply emotional",
    negative_hint: "",
  },
  {
    id: "dramatic-letter",
    title: "A Letter Left Behind",
    mood: "She read it three times. The fourth time she couldn't finish it.",
    category: "dramatic",
    template: "1girl, {character}, letter in hand, {{tears streaming}}, indoors, sitting on floor, knees to chest, soft window light, afternoon, [color], muted palette, grief, close-up on face and hands, intimate",
    negative_hint: "",
  },
  {
    id: "dramatic-reaching",
    title: "Almost",
    mood: "Two hands reaching toward each other across a distance that keeps growing.",
    category: "dramatic",
    template: "1boy, 1girl, {couple}, {{reaching toward each other}}, hands almost touching, dramatic lighting, {emotional}, separated by gap, tears, desperate expression, backlit, rim lighting, muted color palette, wide shot with space between figures",
    negative_hint: "",
  },
  {
    id: "dramatic-kneeling",
    title: "The Weight of It",
    mood: "When the adrenaline ran out, her legs gave way. She let them.",
    category: "dramatic",
    template: "1girl, {character}, kneeling on ground, {exhausted}, battle aftermath, outdoor, sunset, {warm side lighting}, head down, hair falling forward, hands on ground, torn clothing, {emotional exhaustion}, wide shot, atmospheric haze",
    negative_hint: "",
  },
  {
    id: "dramatic-window-vigil",
    title: "Still Waiting",
    mood: "She's been at that window for an hour. She knows he's not coming. She stays anyway.",
    category: "dramatic",
    template: "1girl, {character}, window, standing, looking out, {{rain outside}}, {melancholy}, indoors, night, room dimly lit, reflection in glass, cup of tea gone cold, muted colors, medium shot from behind, atmospheric",
    negative_hint: "",
  },
  {
    id: "dramatic-collapse",
    title: "Breaking Point",
    mood: "She held it together until she didn't. No one saw. Just her and the floor.",
    category: "dramatic",
    template: "1girl, {character}, sitting against wall, knees drawn up, {tears}, face hidden, dim room, {dramatic side lighting}, shadow play, high contrast, [color], desaturated except for one warm light source, intimate, close-up",
    negative_hint: "",
  },

  // ── NATURE / LANDSCAPE ────────────────────────────────────────────────────

  {
    id: "nature-cliff-ocean",
    title: "Edge of the World",
    mood: "Standing at the cliff's edge where the land gives way to infinite sea and sky.",
    category: "nature",
    template: "background dataset, ocean cliff, {dramatic sky}, stormy sea below, rocky coastline, {wind}, waves crashing on rocks, {{atmospheric}}, overcast light, wild grasses, no people, wide establishing shot, cinematic framing, muted coastal palette",
    negative_hint: "people, characters",
  },
  {
    id: "nature-cherry-blossom",
    title: "Sakura Storm",
    mood: "A path through cherry blossoms in full bloom — petals falling like slow pink snow.",
    category: "nature",
    template: "background dataset, cherry blossom path, {petals falling}, spring, {soft pink light}, trees arching overhead, no people, {dappled sunlight}, pathway leading into distance, peaceful, impressionistic, wide shot",
    negative_hint: "people",
  },
  {
    id: "nature-aurora",
    title: "Northern Lights",
    mood: "The sky is on fire with color and the lake below reflects every impossible shade.",
    category: "nature",
    template: "background dataset, {{aurora borealis}}, night sky, {vivid green and purple}, frozen lake reflection, snow covered landscape, pine trees, stars, no people, wide shot, epic sky, low horizon, perfect reflection",
    negative_hint: "people, daylight",
  },
  {
    id: "nature-misty-mountain",
    title: "Above the Clouds",
    mood: "Mountain peaks breaking through the mist below — the world is very small from here.",
    category: "nature",
    template: "background dataset, mountain summit, {sea of clouds}, morning, {golden sunrise}, peaks above mist, dramatic scale, no people, {atmospheric perspective}, blue and gold palette, wide shot, panoramic, epic landscape",
    negative_hint: "people",
  },
  {
    id: "nature-bamboo",
    title: "Bamboo Temple Path",
    mood: "A stone path through bamboo forest — light comes in vertical slashes, absolute silence.",
    category: "nature",
    template: "background dataset, bamboo forest, stone path, {filtered green light}, japanese aesthetic, no people, moss on stones, small shrine in distance, {atmospheric}, morning mist, vertical composition, serene",
    negative_hint: "people",
  },
  {
    id: "nature-thunderstorm",
    title: "Strike",
    mood: "The moment lightning hits — everything white, then the world comes back changed.",
    category: "nature",
    template: "background dataset, {{lightning strike}}, thunderstorm, dark dramatic sky, {flash illumination}, rain, open field, lone tree, {{high contrast}}, no people, dramatic, power of nature, wide shot",
    negative_hint: "people, soft colors",
  },

  // ── NSFW ─────────────────────────────────────────────────────────────────

  {
    id: "nsfw-lingerie-window",
    title: "Morning Window",
    mood: "Morning light through sheer curtains, unhurried, comfortable in her own skin.",
    category: "nsfw",
    template: "1girl, {character}, lingerie, {{beautiful body}}, standing at window, morning light, sheer curtains, {soft backlighting}, bare skin, bare shoulders, sensual, relaxed expression, indoors, bedroom, medium shot, tasteful, aesthetic",
    negative_hint: "bad anatomy, lowres",
  },
  {
    id: "nsfw-bath-steam",
    title: "Steam",
    mood: "Hot bath, steam everywhere, completely at ease.",
    category: "nsfw",
    template: "1girl, {character}, bathtub, {steam}, {{wet skin}}, bare shoulders, bubbles, relaxed expression, bathroom, warm lighting, {sensual}, damp hair, indoors, close-up, soft lighting, water droplets",
    negative_hint: "bad anatomy",
  },
  {
    id: "nsfw-topless-nature",
    title: "Wild",
    mood: "Somewhere remote and beautiful, completely free, no apologies.",
    category: "nsfw",
    template: "1girl, {character}, topless, outdoors, nature, forest clearing, dappled sunlight, bare skin, {natural beauty}, confident expression, medium shot, environmental portrait, warm lighting, wind in hair",
    negative_hint: "bad anatomy, urban background",
  },
  {
    id: "nsfw-couple-sheets",
    title: "Sunday Morning",
    mood: "Tangled in sheets, no rush, the whole morning ahead of them.",
    category: "nsfw",
    template: "1boy, 1girl, {couple}, lying in bed, {{intimacy}}, sheets, morning, {soft warm light}, bedroom, bare shoulders, relaxed expression, post-intimacy glow, medium shot, shallow depth of field, warm palette",
    negative_hint: "bad anatomy",
  },
  {
    id: "nsfw-explicit-pinned",
    title: "Against the Wall",
    mood: "Urgent, wanting, no patience left for patience.",
    category: "nsfw",
    template: "rating:explicit, 1boy, 1girl, {couple}, {{sex}}, against wall, pinned, {passionate}, kissing, bare skin, clothing partially removed, indoors, dim lighting, {desire}, close-up, intense expression",
    negative_hint: "bad anatomy, extra limbs",
  },
  {
    id: "nsfw-explicit-floor",
    title: "On the Floor",
    mood: "They didn't make it to the bedroom. Neither of them is complaining.",
    category: "nsfw",
    template: "rating:explicit, 1boy, 1girl, {couple}, {{sex}}, lying on floor, bare skin, clothing discarded, {passionate}, intertwined, {warm light from fireplace}, carpet, indoors, medium shot, [harsh lighting]",
    negative_hint: "bad anatomy, extra limbs",
  },
  {
    id: "nsfw-dominant-gaze",
    title: "The Look",
    mood: "She knows exactly what she's doing. She always does.",
    category: "nsfw",
    template: "1girl, {character}, {{confident}}, lingerie, sitting on chair, crossed legs, {{direct gaze into camera}}, smirk, bare skin, dim room, single key light, [dark shadows], sensual, dominant expression, close-up on face",
    negative_hint: "bad anatomy",
  },
  {
    id: "nsfw-explicit-rear",
    title: "From Behind",
    mood: "Lost in each other, completely.",
    category: "nsfw",
    template: "rating:explicit, 1boy, 1girl, {couple}, {{sex from behind}}, bare skin, {moaning expression}, bedroom, {warm lighting}, sheets gripped, dynamic, medium shot, shallow depth of field",
    negative_hint: "bad anatomy, extra limbs, deformed",
  },
  {
    id: "nsfw-solo-explicit",
    title: "Alone with Herself",
    mood: "Unguarded and entirely herself.",
    category: "nsfw",
    template: "rating:explicit, 1girl, {character}, {{nude}}, lying on bed, self-pleasure, bare skin, {natural lighting}, bedroom, daytime, relaxed expression, soft aesthetic, solo, medium shot",
    negative_hint: "bad anatomy, extra limbs",
  },

];

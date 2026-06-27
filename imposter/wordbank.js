/*
 * imposter-wordbank — backbone (schema + categories + loader)
 * ----------------------------------------------------------------------------
 * Words themselves live in content/<category>.js files, each calling addWords().
 * Loading order (see index.html): wordbank.js -> content/*.js -> app script.
 *
 * WORD TUPLE FORMAT used in content files:
 *   addWords("anime", [
 *     // [ subgroupId, difficulty(1-3), enTerm, ruTerm, draw? ]
 *     ["naruto", 1, "Naruto Uzumaki", "Наруто Удзумаки"],
 *     ["objects", 1, "Umbrella", "Зонт", "draw"],   // 5th arg flags draw-able
 *   ]);
 *
 * difficulty: 1 = easy / everyone-knows · 2 = medium / fan · 3 = hard / niche
 * draw      : pass "draw" (or true) only when a non-artist could sketch it.
 *             Every word is "talk" by default; "draw" is additive.
 *
 * A word with a blank en or ru term is skipped (so a missing translation simply
 * drops that word from that language's pool — spec §4).
 */
window.WORDBANK = {
  schemaVersion: 2,
  languages: ["en", "ru"],
  words: [],

  // ----- categories ---------------------------------------------------------
  // free:true  => full control (subgroup + difficulty toggles) without purchase.
  //               These are the casual "showcase" categories. All others are paid.
  categories: [
    // ===== FREE showcases ===================================================
    { id: "geography", icon: "🗺️", free: true,
      name: { en: "Geography", ru: "География" },
      blurb: { en: "Countries, cities and landmarks.", ru: "Страны, города и достопримечательности." },
      subgroups: [
        { id: "countries", name: { en: "Countries", ru: "Страны" } },
        { id: "cities",    name: { en: "Cities",    ru: "Города" } },
        { id: "capitals",  name: { en: "Capitals",  ru: "Столицы" } },
        { id: "landmarks", name: { en: "Landmarks", ru: "Достопримечательности" } },
        { id: "flags",     name: { en: "Flags",     ru: "Флаги" } },
        { id: "wonders",   name: { en: "Natural Wonders", ru: "Чудеса природы" } },
      ] },
    { id: "food", icon: "🍔", free: true,
      name: { en: "Food & Drink", ru: "Еда и напитки" },
      blurb: { en: "Great for drawing. Everyone knows food.", ru: "Отлично для рисования. Еду знают все." },
      subgroups: [
        { id: "fastfood",  name: { en: "Fast Food",   ru: "Фастфуд" } },
        { id: "fruitveg",  name: { en: "Fruits & Veg",ru: "Фрукты и овощи" } },
        { id: "desserts",  name: { en: "Desserts",    ru: "Десерты" } },
        { id: "cuisine",   name: { en: "World Cuisine",ru: "Кухни мира" } },
        { id: "drinks",    name: { en: "Drinks",      ru: "Напитки" } },
        { id: "snacks",    name: { en: "Snacks",      ru: "Снэки" } },
      ] },
    { id: "animals", icon: "🐾", free: true,
      name: { en: "Animals", ru: "Животные" },
      blurb: { en: "Pets, wildlife, sea and more.", ru: "Питомцы, дикие, морские и другие." },
      subgroups: [
        { id: "pets",      name: { en: "Pets & Farm", ru: "Питомцы и ферма" } },
        { id: "wild",      name: { en: "Wild",        ru: "Дикие" } },
        { id: "sea",       name: { en: "Sea",         ru: "Морские" } },
        { id: "birds",     name: { en: "Birds",       ru: "Птицы" } },
        { id: "bugs",      name: { en: "Bugs",        ru: "Насекомые" } },
        { id: "dinosaurs", name: { en: "Dinosaurs",   ru: "Динозавры" } },
        { id: "mythical",  name: { en: "Mythical",    ru: "Мифические" } },
      ] },
    { id: "jobs", icon: "👷", free: true,
      name: { en: "Jobs & Professions", ru: "Профессии" },
      blurb: { en: "Charades-friendly, all ages.", ru: "Удобно для шарад, для всех возрастов." },
      subgroups: [
        { id: "everyday",  name: { en: "Everyday",   ru: "Повседневные" } },
        { id: "uniformed", name: { en: "Uniformed",  ru: "В форме" } },
        { id: "trades",    name: { en: "Trades",     ru: "Рабочие" } },
        { id: "creative",  name: { en: "Creative",   ru: "Творческие" } },
        { id: "unusual",   name: { en: "Unusual",    ru: "Необычные" } },
      ] },
    { id: "objects", icon: "📦", free: true,
      name: { en: "Objects", ru: "Предметы" },
      blurb: { en: "Everyday things — great for drawing.", ru: "Повседневные вещи — отлично для рисования." },
      subgroups: [
        { id: "household",  name: { en: "Household",   ru: "Дом" } },
        { id: "kitchen",    name: { en: "Kitchen",     ru: "Кухня" } },
        { id: "tools",      name: { en: "Tools",       ru: "Инструменты" } },
        { id: "tech",       name: { en: "Electronics", ru: "Электроника" } },
        { id: "clothing",   name: { en: "Clothing",    ru: "Одежда" } },
        { id: "stationery", name: { en: "Stationery & Misc", ru: "Канцелярия и разное" } },
      ] },
    { id: "places", icon: "📍", free: true,
      name: { en: "Places", ru: "Места" },
      blurb: { en: "Locations real and imagined.", ru: "Места реальные и выдуманные." },
      subgroups: [
        { id: "home",      name: { en: "Home",             ru: "Дом" } },
        { id: "public",    name: { en: "Public Buildings", ru: "Общественные места" } },
        { id: "outdoors",  name: { en: "Outdoors",         ru: "На природе" } },
        { id: "travel",    name: { en: "Travel",           ru: "Путешествия" } },
        { id: "imaginary", name: { en: "Imaginary & Space",ru: "Выдуманные и космос" } },
      ] },
    { id: "drawing", icon: "✏️", free: true,
      name: { en: "Drawing", ru: "Рисование" },
      blurb: { en: "Easy-to-draw words for sketch rounds.", ru: "Простые слова для раундов с рисованием." },
      subgroups: [
        { id: "objects",  name: { en: "Objects",  ru: "Предметы" } },
        { id: "animals",  name: { en: "Animals",  ru: "Животные" } },
        { id: "vehicles", name: { en: "Vehicles", ru: "Транспорт" } },
        { id: "nature",   name: { en: "Nature",   ru: "Природа" } },
        { id: "food",     name: { en: "Food",     ru: "Еда" } },
        { id: "symbols",  name: { en: "Shapes & Symbols", ru: "Фигуры и символы" } },
      ] },

    // ===== PAID — Sports (each separate) ====================================
    { id: "football", icon: "⚽",
      name: { en: "Football", ru: "Футбол" },
      blurb: { en: "Legends, eras, leagues and clubs.", ru: "Легенды, эпохи, лиги и клубы." },
      subgroups: [
        { id: "legends",        name: { en: "Legends",            ru: "Легенды" } },
        { id: "era_epl",        name: { en: "EPL '08–'20",        ru: "АПЛ '08–'20" } },
        { id: "era_laliga",     name: { en: "La Liga '08–'20",    ru: "Ла Лига '08–'20" } },
        { id: "era_seriea",     name: { en: "Serie A '08–'20",    ru: "Серия А '08–'20" } },
        { id: "era_bundesliga", name: { en: "Bundesliga '08–'20", ru: "Бундеслига '08–'20" } },
        { id: "era_ligue1",     name: { en: "Ligue 1 '08–'20",    ru: "Лига 1 '08–'20" } },
        { id: "cur_epl",        name: { en: "EPL Now",            ru: "АПЛ сейчас" } },
        { id: "cur_laliga",     name: { en: "La Liga Now",        ru: "Ла Лига сейчас" } },
        { id: "cur_seriea",     name: { en: "Serie A Now",        ru: "Серия А сейчас" } },
        { id: "cur_bundesliga", name: { en: "Bundesliga Now",     ru: "Бундеслига сейчас" } },
        { id: "cur_ligue1",     name: { en: "Ligue 1 Now",        ru: "Лига 1 сейчас" } },
        { id: "clubs",          name: { en: "Clubs",              ru: "Клубы" } },
        { id: "national",       name: { en: "National Teams",     ru: "Сборные" } },
      ] },
    { id: "nba", icon: "🏀",
      name: { en: "NBA", ru: "НБА" },
      blurb: { en: "Stars & legends, team by team.", ru: "Звёзды и легенды, команда за командой." },
      subgroups: [
        { id: "celtics",   name: { en: "Celtics",       ru: "Бостон Селтикс" } },
        { id: "nets",      name: { en: "Nets",          ru: "Бруклин Нетс" } },
        { id: "knicks",    name: { en: "Knicks",        ru: "Нью-Йорк Никс" } },
        { id: "sixers",    name: { en: "76ers",         ru: "Филадельфия Сиксерс" } },
        { id: "raptors",   name: { en: "Raptors",       ru: "Торонто Рэпторс" } },
        { id: "bulls",     name: { en: "Bulls",         ru: "Чикаго Буллз" } },
        { id: "cavs",      name: { en: "Cavaliers",     ru: "Кливленд Кавальерс" } },
        { id: "pistons",   name: { en: "Pistons",       ru: "Детройт Пистонс" } },
        { id: "pacers",    name: { en: "Pacers",        ru: "Индиана Пэйсерс" } },
        { id: "bucks",     name: { en: "Bucks",         ru: "Милуоки Бакс" } },
        { id: "hawks",     name: { en: "Hawks",         ru: "Атланта Хокс" } },
        { id: "hornets",   name: { en: "Hornets",       ru: "Шарлотт Хорнетс" } },
        { id: "heat",      name: { en: "Heat",          ru: "Майами Хит" } },
        { id: "magic",     name: { en: "Magic",         ru: "Орландо Мэджик" } },
        { id: "wizards",   name: { en: "Wizards",       ru: "Вашингтон Уизардс" } },
        { id: "nuggets",   name: { en: "Nuggets",       ru: "Денвер Наггетс" } },
        { id: "wolves",    name: { en: "Timberwolves",  ru: "Миннесота Тимбервулвз" } },
        { id: "thunder",   name: { en: "Thunder",       ru: "Оклахома-Сити Тандер" } },
        { id: "blazers",   name: { en: "Trail Blazers", ru: "Портленд Блэйзерс" } },
        { id: "jazz",      name: { en: "Jazz",          ru: "Юта Джаз" } },
        { id: "warriors",  name: { en: "Warriors",      ru: "Голден Стэйт Уорриорз" } },
        { id: "clippers",  name: { en: "Clippers",      ru: "Лос-Анджелес Клипперс" } },
        { id: "lakers",    name: { en: "Lakers",        ru: "Лос-Анджелес Лейкерс" } },
        { id: "suns",      name: { en: "Suns",          ru: "Финикс Санз" } },
        { id: "kings",     name: { en: "Kings",         ru: "Сакраменто Кингз" } },
        { id: "mavs",      name: { en: "Mavericks",     ru: "Даллас Маверикс" } },
        { id: "rockets",   name: { en: "Rockets",       ru: "Хьюстон Рокетс" } },
        { id: "grizzlies", name: { en: "Grizzlies",     ru: "Мемфис Гриззлис" } },
        { id: "pelicans",  name: { en: "Pelicans",      ru: "Нью-Орлеан Пеликанс" } },
        { id: "spurs",     name: { en: "Spurs",         ru: "Сан-Антонио Спёрс" } },
      ] },
    { id: "tennis", icon: "🎾",
      name: { en: "Tennis", ru: "Теннис" },
      blurb: { en: "ATP, WTA and the legends.", ru: "ATP, WTA и легенды." },
      subgroups: [
        { id: "atp",     name: { en: "Men (ATP)",  ru: "Мужчины (ATP)" } },
        { id: "wta",     name: { en: "Women (WTA)", ru: "Женщины (WTA)" } },
        { id: "legends", name: { en: "Legends",    ru: "Легенды" } },
      ] },
    { id: "boxing", icon: "🥊",
      name: { en: "Boxing", ru: "Бокс" },
      blurb: { en: "Champions past and present.", ru: "Чемпионы прошлого и настоящего." },
      subgroups: [
        { id: "current",   name: { en: "Current",   ru: "Текущие" } },
        { id: "legends",   name: { en: "Legends",   ru: "Легенды" } },
      ] },
    { id: "ufc", icon: "🥋",
      name: { en: "UFC / MMA", ru: "UFC / ММА" },
      blurb: { en: "Champions and legends of the cage.", ru: "Чемпионы и легенды октагона." },
      subgroups: [
        { id: "champions", name: { en: "Champions", ru: "Чемпионы" } },
        { id: "legends",   name: { en: "Legends",   ru: "Легенды" } },
      ] },
    { id: "f1", icon: "🏎️",
      name: { en: "Formula 1", ru: "Формула-1" },
      blurb: { en: "Drivers, teams and circuits.", ru: "Пилоты, команды и трассы." },
      subgroups: [
        { id: "drivers",  name: { en: "Current Drivers", ru: "Пилоты" } },
        { id: "legends",  name: { en: "Legends",         ru: "Легенды" } },
        { id: "teams",    name: { en: "Constructors",    ru: "Команды" } },
        { id: "circuits", name: { en: "Circuits",        ru: "Трассы" } },
      ] },

    // ===== PAID — Entertainment & Fandom ====================================
    { id: "anime", icon: "🌀",
      name: { en: "Anime", ru: "Аниме" },
      blurb: { en: "Characters across the big shows.", ru: "Персонажи из главных тайтлов." },
      subgroups: [
        { id: "jjk",         name: { en: "Jujutsu Kaisen",   ru: "Магическая битва" } },
        { id: "demonslayer", name: { en: "Demon Slayer",     ru: "Клинок, рассекающий демонов" } },
        { id: "onepiece",    name: { en: "One Piece",        ru: "Ван-Пис" } },
        { id: "naruto",      name: { en: "Naruto",           ru: "Наруто" } },
        { id: "aot",         name: { en: "Attack on Titan",  ru: "Атака титанов" } },
        { id: "dragonball",  name: { en: "Dragon Ball",      ru: "Драконий жемчуг" } },
        { id: "sololeveling",name: { en: "Solo Leveling",    ru: "Поднятие уровня в одиночку" } },
        { id: "frieren",     name: { en: "Frieren",          ru: "Фрирен" } },
        { id: "chainsawman", name: { en: "Chainsaw Man",     ru: "Человек-бензопила" } },
        { id: "spyfamily",   name: { en: "Spy×Family",       ru: "Семья шпиона" } },
        { id: "bleach",      name: { en: "Bleach",           ru: "Блич" } },
        { id: "deathnote",   name: { en: "Death Note",       ru: "Тетрадь смерти" } },
        { id: "mha",         name: { en: "My Hero Academia", ru: "Моя геройская академия" } },
        { id: "hunterxhunter", name: { en: "Hunter × Hunter", ru: "Хантер × Хантер" } },
        { id: "bluelock",      name: { en: "Blue Lock",       ru: "Блю Лок" } },
        { id: "tokyorevengers",name: { en: "Tokyo Revengers", ru: "Токийские мстители" } },
        { id: "vinlandsaga",   name: { en: "Vinland Saga",    ru: "Сага о Винланде" } },
        { id: "jojo",          name: { en: "JoJo's Bizarre Adventure", ru: "Приключения ДжоДжо" } },
        { id: "fma",           name: { en: "Fullmetal Alchemist", ru: "Стальной алхимик" } },
        { id: "onepunchman",   name: { en: "One-Punch Man",   ru: "Ванпанчмен" } },
        { id: "mobpsycho",     name: { en: "Mob Psycho 100",  ru: "Моб Психо 100" } },
        { id: "haikyu",        name: { en: "Haikyuu!!",       ru: "Волейбол!!" } },
        { id: "blackclover",   name: { en: "Black Clover",    ru: "Чёрный клевер" } },
        { id: "fairytail",     name: { en: "Fairy Tail",      ru: "Хвост феи" } },
        { id: "tokyoghoul",    name: { en: "Tokyo Ghoul",     ru: "Токийский гуль" } },
        { id: "sds",           name: { en: "Seven Deadly Sins", ru: "Семь смертных грехов" } },
        { id: "sao",           name: { en: "Sword Art Online",ru: "Мастера меча онлайн" } },
        { id: "rezero",        name: { en: "Re:Zero",         ru: "Re:Zero" } },
        { id: "drstone",       name: { en: "Dr. Stone",       ru: "Доктор Стоун" } },
        { id: "fireforce",     name: { en: "Fire Force",      ru: "Пламенная бригада" } },
        { id: "promisedneverland", name: { en: "The Promised Neverland", ru: "Обещанный Неверленд" } },
        { id: "codegeass",     name: { en: "Code Geass",      ru: "Код Гиас" } },
        { id: "evangelion",    name: { en: "Evangelion",      ru: "Евангелион" } },
        { id: "steinsgate",    name: { en: "Steins;Gate",     ru: "Врата Штейна" } },
        { id: "tensura",       name: { en: "Slime (Tensura)", ru: "Реинкарнация в слизь" } },
        { id: "dandadan",      name: { en: "Dandadan",        ru: "Дандадан" } },
        { id: "kaiju8",        name: { en: "Kaiju No. 8",     ru: "Кайдзю №8" } },
        { id: "oshinoko",      name: { en: "Oshi no Ko",      ru: "Звёздное дитя" } },
        { id: "konosuba",      name: { en: "KonoSuba",        ru: "КоноСуба" } },
        { id: "sakamoto",      name: { en: "Sakamoto Days",   ru: "Дни Сакамото" } },
        { id: "inuyasha",      name: { en: "Inuyasha",        ru: "Инуяша" } },
        { id: "cowboybebop",   name: { en: "Cowboy Bebop",    ru: "Ковбой Бибоп" } },
        { id: "bungostray",    name: { en: "Bungo Stray Dogs",ru: "Бродячие псы" } },
      ] },
    { id: "games", icon: "🎮",
      name: { en: "Video Games", ru: "Видеоигры" },
      blurb: { en: "Game names or characters — your pick.", ru: "Названия игр или персонажи — на выбор." },
      subgroups: [
        // ----- GAME NAMES (titles) -----
        { id: "t_shooter", kind: "title", name: { en: "Shooters",           ru: "Шутеры" } },
        { id: "t_action",  kind: "title", name: { en: "Action / Open-World", ru: "Экшен / Открытый мир" } },
        { id: "t_rpg",     kind: "title", name: { en: "RPG & Fantasy",       ru: "RPG и фэнтези" } },
        { id: "t_sports",  kind: "title", name: { en: "Sports & Racing",     ru: "Спорт и гонки" } },
        { id: "t_online",  kind: "title", name: { en: "Online & Sandbox",    ru: "Онлайн и песочницы" } },
        { id: "t_classic", kind: "title", name: { en: "Classics & Arcade",   ru: "Классика и аркады" } },
        // ----- CHARACTERS (by franchise) -----
        { id: "nintendo",    kind: "char", name: { en: "Mario / Nintendo", ru: "Марио / Nintendo" } },
        { id: "pokemon",     kind: "char", name: { en: "Pokémon",          ru: "Покемоны" } },
        { id: "zelda",       kind: "char", name: { en: "Zelda",            ru: "Zelda" } },
        { id: "sonic",       kind: "char", name: { en: "Sonic",            ru: "Соник" } },
        { id: "minecraft",   kind: "char", name: { en: "Minecraft",        ru: "Minecraft" } },
        { id: "fortnite",    kind: "char", name: { en: "Fortnite",         ru: "Fortnite" } },
        { id: "gta",         kind: "char", name: { en: "GTA",              ru: "GTA" } },
        { id: "cod",         kind: "char", name: { en: "Call of Duty",     ru: "Call of Duty" } },
        { id: "lol",         kind: "char", name: { en: "League of Legends",ru: "League of Legends" } },
        { id: "fromsoft",    kind: "char", name: { en: "Elden Ring / Souls",ru: "Elden Ring / Souls" } },
        { id: "residentevil",kind: "char", name: { en: "Resident Evil",    ru: "Resident Evil" } },
        { id: "fnaf",        kind: "char", name: { en: "FNAF / Among Us",  ru: "FNAF / Among Us" } },
        { id: "overwatch",   kind: "char", name: { en: "Overwatch",        ru: "Overwatch" } },
        { id: "genshin",     kind: "char", name: { en: "Genshin Impact",   ru: "Genshin Impact" } },
        { id: "valorant",    kind: "char", name: { en: "Valorant",         ru: "Valorant" } },
      ] },
    { id: "films", icon: "🎬",
      name: { en: "Films", ru: "Фильмы" },
      blurb: { en: "Movies by era, genre and country.", ru: "Фильмы по эпохам, жанрам и странам." },
      subgroups: [
        { id: "classics",   name: { en: "80s / 90s Classics", ru: "Классика 80-90х" } },
        { id: "modern",     name: { en: "Modern Blockbusters",ru: "Современные блокбастеры" } },
        { id: "korean",     name: { en: "Korean",            ru: "Корейское кино" } },
        { id: "animation",  name: { en: "Animation / Pixar", ru: "Анимация / Pixar" } },
        { id: "horror",     name: { en: "Horror",            ru: "Хорроры" } },
        { id: "franchises", name: { en: "Action Franchises", ru: "Боевик-франшизы" } },
        { id: "prestige",   name: { en: "Oscar / Prestige",  ru: "Оскар / Престиж" } },
        { id: "ch_starwars",    name: { en: "Star Wars chars",    ru: "Персонажи Star Wars" } },
        { id: "ch_harrypotter", name: { en: "Harry Potter chars", ru: "Персонажи Гарри Поттера" } },
        { id: "ch_lotr",        name: { en: "LOTR chars",         ru: "Персонажи Властелина колец" } },
        { id: "ch_disney",      name: { en: "Disney / Pixar chars", ru: "Персонажи Disney / Pixar" } },
        { id: "ch_bond",        name: { en: "James Bond chars",   ru: "Персонажи Джеймса Бонда" } },
        { id: "ch_action",      name: { en: "Action movie chars", ru: "Персонажи боевиков" } },
      ] },
    { id: "music", icon: "🎵",
      name: { en: "Music", ru: "Музыка" },
      blurb: { en: "Artists across the genres.", ru: "Исполнители разных жанров." },
      subgroups: [
        { id: "pop",     name: { en: "Pop",          ru: "Поп" } },
        { id: "hiphop",  name: { en: "Hip-Hop / Rap",ru: "Хип-хоп / Рэп" } },
        { id: "latin",   name: { en: "Latin",        ru: "Латино" } },
        { id: "rock",    name: { en: "Rock & Legends",ru: "Рок и легенды" } },
        { id: "edm",     name: { en: "EDM / DJs",    ru: "EDM / ди-джеи" } },
        { id: "country", name: { en: "Country",      ru: "Кантри" } },
      ] },
    { id: "kpop", icon: "💜",
      name: { en: "K-pop", ru: "K-pop" },
      blurb: { en: "Groups, idols and rookies.", ru: "Группы, айдолы и новички." },
      subgroups: [
        { id: "boygroups",  name: { en: "Boy Groups",  ru: "Бой-группы" } },
        { id: "girlgroups", name: { en: "Girl Groups", ru: "Гёрл-группы" } },
        { id: "soloists",   name: { en: "Soloists",    ru: "Сольные артисты" } },
        { id: "rookies",    name: { en: "Rookies",     ru: "Новички" } },
      ] },
    { id: "superheroes", icon: "🦸",
      name: { en: "Superheroes", ru: "Супергерои" },
      blurb: { en: "Marvel & DC heroes and villains.", ru: "Герои и злодеи Marvel и DC." },
      subgroups: [
        { id: "avengers",      name: { en: "Avengers",       ru: "Мстители" } },
        { id: "xmen",          name: { en: "X-Men",          ru: "Люди Икс" } },
        { id: "spiderverse",   name: { en: "Spider-verse",   ru: "Вселенная Человека-паука" } },
        { id: "marvelvillains",name: { en: "Marvel Villains",ru: "Злодеи Marvel" } },
        { id: "dcheroes",      name: { en: "DC Heroes",      ru: "Герои DC" } },
        { id: "dcvillains",    name: { en: "DC Villains",    ru: "Злодеи DC" } },
      ] },
    { id: "famous", icon: "🌟",
      name: { en: "Famous People", ru: "Знаменитости" },
      blurb: { en: "The faces everyone knows.", ru: "Лица, которые знают все." },
      subgroups: [
        { id: "actors",     name: { en: "Actors",            ru: "Актёры" } },
        { id: "musicians",  name: { en: "Musicians",         ru: "Музыканты" } },
        { id: "athletes",   name: { en: "Athletes",          ru: "Спортсмены" } },
        { id: "tech",       name: { en: "Tech & Business",   ru: "Технологии и бизнес" } },
        { id: "influencers",name: { en: "Influencers",       ru: "Блогеры" } },
        { id: "leaders",    name: { en: "World Leaders",     ru: "Мировые лидеры" } },
      ] },
    { id: "internet", icon: "💻",
      name: { en: "Internet & Memes", ru: "Интернет и мемы" },
      blurb: { en: "Evergreen online culture.", ru: "Вечная интернет-культура." },
      subgroups: [
        { id: "memes",     name: { en: "Classic Memes",   ru: "Классические мемы" } },
        { id: "reactions", name: { en: "Reaction Faces",  ru: "Реакшн-фейсы" } },
        { id: "characters",name: { en: "Viral Characters",ru: "Вирусные персонажи" } },
        { id: "apps",      name: { en: "Apps & Sites",    ru: "Приложения и сайты" } },
        { id: "creators",  name: { en: "Creators",        ru: "Блогеры и стримеры" } },
      ] },

    // ===== PAID — Knowledge / Evergreen =====================================
    { id: "history", icon: "🏛️",
      name: { en: "History", ru: "История" },
      blurb: { en: "Difficulty is the slice: known → nerd.", ru: "Срез — это сложность: известное → задроты." },
      subgroups: [
        { id: "people",  name: { en: "Famous People", ru: "Известные люди" } },
        { id: "events",  name: { en: "Events",        ru: "События" } },
        { id: "ancient", name: { en: "Ancient",       ru: "Древний мир" } },
        { id: "modern",  name: { en: "Modern",        ru: "Новейшая история" } },
      ] },
    { id: "nature", icon: "🌿",
      name: { en: "Nature", ru: "Природа" },
      blurb: { en: "Weather, plants, landforms, sky.", ru: "Погода, растения, ландшафты, небо." },
      subgroups: [
        { id: "weather",   name: { en: "Weather",   ru: "Погода" } },
        { id: "plants",    name: { en: "Plants",    ru: "Растения" } },
        { id: "landforms", name: { en: "Landforms", ru: "Ландшафты" } },
        { id: "space",     name: { en: "Space & Sky",ru: "Небо и космос" } },
      ] },
    { id: "science", icon: "🔬",
      name: { en: "Science", ru: "Наука" },
      blurb: { en: "Space, the body, inventions.", ru: "Космос, тело, изобретения." },
      subgroups: [
        { id: "space",      name: { en: "Astronomy",   ru: "Астрономия" } },
        { id: "body",       name: { en: "Human Body",  ru: "Тело человека" } },
        { id: "inventions", name: { en: "Inventions",  ru: "Изобретения" } },
        { id: "elements",   name: { en: "Elements",    ru: "Элементы" } },
        { id: "tech",       name: { en: "Technology",  ru: "Технологии" } },
      ] },
    { id: "cars", icon: "🚗",
      name: { en: "Car Brands", ru: "Марки авто" },
      blurb: { en: "Logos are perfect to draw.", ru: "Логотипы идеально рисовать." },
      subgroups: [
        { id: "luxury",   name: { en: "Luxury",        ru: "Люкс" } },
        { id: "sports",   name: { en: "Sports / Super",ru: "Спорт / Супер" } },
        { id: "everyday", name: { en: "Everyday",      ru: "Массовые" } },
        { id: "ev",       name: { en: "Electric",      ru: "Электромобили" } },
        { id: "classic",  name: { en: "Classic",       ru: "Классика" } },
      ] },
  ],
};

// ----- loader ---------------------------------------------------------------
// Tuple: [subgroup, difficulty, en, ru, extra1?, extra2?]
//   extra slots accept "draw" (or true) to flag draw-able, and a NUMBER for year.
//   e.g. ["modern", 1, "Inception", "Начало", 2010]
//        ["nintendo", 1, "Mario", "Марио", "draw", 1985]
window.addWords = function (category, rows) {
  const W = window.WORDBANK;
  for (const r of rows) {
    const [subgroup, difficulty, en, ru, a, b] = r;
    if (!en || !ru) continue; // missing translation => excluded from that pool
    let draw = false, year = null;
    for (const v of [a, b]) {
      if (v === undefined || v === null) continue;
      if (v === "draw" || v === true) draw = true;
      else if (typeof v === "number") year = v;
    }
    const word = {
      id: category + "_" + W.words.length,
      category,
      subgroup,
      difficulty,
      playstyles: draw ? ["talk", "draw"] : ["talk"],
      term: { en, ru },
    };
    if (year != null) word.year = year;
    W.words.push(word);
  }
};

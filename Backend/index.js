const { createServer } = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

const httpServer = createServer();
const io = new Server(httpServer, { cors: { origin: "*" } });

// ─────────────────────────────────────────────
//  Question Bank
// ─────────────────────────────────────────────
let questionBank = {};
try {
    questionBank = JSON.parse(fs.readFileSync("./questions.json", "utf8"));
    console.log("✅ questions.json loaded. Themes:", Object.keys(questionBank));
} catch(e) {
    console.error("❌ Failed to load questions.json:", e.message);
}

const THEMES = Object.keys(questionBank); // ["JIIT-62","TV Shows","Music","Sports","Basic Math + GK"]

// Theme display emojis — purely cosmetic, sent to client
const THEME_EMOJI = {
    "JIIT-62":         "🎓",
    "TV Shows":        "📺",
    "Music":           "🎵",
    "Sports":          "⚽",
    "Basic Math + GK": "🧮",
};

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const ROUND_DURATION   = 180;
const ROUNDS_TO_WIN    = 2;
const MAX_PER_SIDE     = 5;
const WIN_LIMIT        = 250;
const PULL_STRENGTH    = 36;
const UNANSWERED_LIMIT = 4;
const ADMIN_PASSWORD   = "arush";

const W_WINS    = 300;
const W_ANSWERS = 5;
const W_TIME    = 2;

// ─────────────────────────────────────────────
//  Global State
// ─────────────────────────────────────────────
let globalTeams = {};
let activeRooms = {};

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function getRandQ(theme, excludeQ = null) {
    const pool = (questionBank[theme] || []).filter(q =>
        excludeQ ? q.q !== excludeQ : true
    );
    if (!pool.length) {
        // Fallback: ignore excludeQ if pool would be empty
        const full = questionBank[theme] || [];
        return full[Math.floor(Math.random() * full.length)] || { q: "?", a: "?" };
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

function makeID() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function sendQuestionToSide(room, side) {
    const r = activeRooms[room];
    if (!r) return;
    const q = r[side + "Q"];
    r.players
        .filter(p => p.side === side)
        .forEach(p => io.to(p.socketId).emit("your-question", q));
}

function buildPlayerLists(r) {
    return {
        redPlayers:  r.players.filter(p => p.side === "red").map(p => ({
            name:   p.playerName,
            ready:  p.ready,
            voted:  p.votedTheme !== null,
        })),
        bluePlayers: r.players.filter(p => p.side === "blue").map(p => ({
            name:   p.playerName,
            ready:  p.ready,
            voted:  p.votedTheme !== null,
        })),
    };
}

function allReadyAndVoted(r) {
    const red  = r.players.filter(p => p.side === "red");
    const blue = r.players.filter(p => p.side === "blue");
    return (
        r.red  !== null &&
        r.blue !== null &&
        red.length  >= 1 &&
        blue.length >= 1 &&
        r.players.every(p => p.ready && p.votedTheme !== null)
    );
}

function resetRoundFlags(r) {
    r.players.forEach(p => {
        p.ready      = false;
        p.votedTheme = null;
    });
    r.votes = {};
}

// Build vote tally from player votes, restricted to available themes
function tallyVotes(r) {
    const tally = {};
    r.players.forEach(p => {
        if (!p.votedTheme) return;
        tally[p.votedTheme] = (tally[p.votedTheme] || 0) + 1;
    });
    return tally;
}

// Pick winning theme from tally, handling ties randomly
function pickWinningTheme(tally, available) {
    // Only count votes for available themes
    const filtered = {};
    available.forEach(t => {
        if (tally[t]) filtered[t] = tally[t];
    });

    if (!Object.keys(filtered).length) {
        // Nobody voted for an available theme — pick random
        return available[Math.floor(Math.random() * available.length)];
    }

    const maxVotes = Math.max(...Object.values(filtered));
    const winners  = Object.keys(filtered).filter(t => filtered[t] === maxVotes);

    // Random pick among tied winners
    return winners[Math.floor(Math.random() * winners.length)];
}

// Themes available for voting this round (excludes already played)
function getAvailableThemes(r) {
    return THEMES.filter(t => !r.playedThemes.includes(t));
}

function recalcScore(gt) {
    if (gt.matchesPlayed === 0 && gt.totalAnswers === 0) {
        gt.score = 0;
        return;
    }
    if (gt.matchesWon === 0) {
        gt.score = gt.totalAnswers * 1;
    } else {
        gt.score =
            (gt.matchesWon   * W_WINS)    +
            (gt.totalAnswers * W_ANSWERS)  -
            (gt.avgTime      * W_TIME);
    }
}

// ─────────────────────────────────────────────
//  Round Logic
// ─────────────────────────────────────────────
function startRound(room) {
    const r = activeRooms[room];
    if (!r || r.matchOver) return;

    // Determine theme for this round from votes
    const available    = getAvailableThemes(r);
    const tally        = tallyVotes(r);
    const chosenTheme  = pickWinningTheme(tally, available);

    r.currentTheme = chosenTheme;
    r.playedThemes.push(chosenTheme);

    r.ropeX          = 0;
    r.roundActive     = true;
    r.roundStartTime  = Date.now();
    r.redQ            = getRandQ(chosenTheme);
    r.blueQ           = getRandQ(chosenTheme, r.redQ.q);
    r.currentRound++;
    r.redUnanswered   = 0;
    r.blueUnanswered  = 0;

    io.to(room).emit("start-round", {
        round:     r.currentRound,
        redScore:  r.redScore,
        blueScore: r.blueScore,
        redName:   r.red.name,
        blueName:  r.blue.name,
        duration:  ROUND_DURATION,
        ropeX:     0,
        winLimit:  WIN_LIMIT,
        theme:     chosenTheme,
        themeEmoji:THEME_EMOJI[chosenTheme] || "❓",
    });

    sendQuestionToSide(room, "red");
    sendQuestionToSide(room, "blue");

    let secondsLeft = ROUND_DURATION;
    r.timerInterval = setInterval(() => {
        if (!r.roundActive) {
            clearInterval(r.timerInterval);
            return;
        }
        secondsLeft--;
        io.to(room).emit("round-tick", { secondsLeft });

        if (secondsLeft <= 0) {
            clearInterval(r.timerInterval);
            handleRoundTimeout(room);
        }
    }, 1000);
}

function concludeRound(room, winningSide) {
    const r = activeRooms[room];
    if (!r) return;

    r.roundActive    = false;
    r.redUnanswered  = 0;
    r.blueUnanswered = 0;
    clearInterval(r.timerInterval);

    const elapsed = Math.floor((Date.now() - r.roundStartTime) / 1000);
    r.redRoundTime  += elapsed;
    r.blueRoundTime += elapsed;

    const isDraw = winningSide === null;
    if (isDraw) {
        r.drawRounds++;
    } else {
        r[winningSide + "Score"]++;
    }

    io.to(room).emit("round-end", {
        draw:       isDraw,
        winner:     winningSide,
        winnerName: winningSide ? r[winningSide].name : null,
        round:      r.currentRound,
        redScore:   r.redScore,
        blueScore:  r.blueScore,
        redName:    r.red.name,
        blueName:   r.blue.name,
        theme:      r.currentTheme,
    });

    checkMatchOver(room);
}

function handleRoundTimeout(room) {
    const r = activeRooms[room];
    if (!r || !r.roundActive) return;
    concludeRound(room, r.ropeX === 0 ? null : (r.ropeX < 0 ? "red" : "blue"));
}

function handleRoundWin(room, winningSide) {
    const r = activeRooms[room];
    if (!r || !r.roundActive) return;
    concludeRound(room, winningSide);
}

function checkMatchOver(room) {
    const r = activeRooms[room];
    if (!r) return;

    const matchDone =
        r.redScore  >= ROUNDS_TO_WIN ||
        r.blueScore >= ROUNDS_TO_WIN ||
        r.currentRound >= 3;

    if (!matchDone) {
        // Reset flags and send players back to vote+ready screen
        resetRoundFlags(r);

        const available = getAvailableThemes(r);

        io.to(room).emit("lobby-update", buildPlayerLists(r));
        io.to(room).emit("go-to-ready", {
            redName:         r.red.name,
            blueName:        r.blue.name,
            round:           r.currentRound + 1,
            availableThemes: available,
            themeEmojis:     THEME_EMOJI,
        });
        return;
    }

    // ── Match over ───────────────────────────────────────────────
    r.matchOver = true;

    let matchWinner = null;
    if      (r.redScore  > r.blueScore) matchWinner = "red";
    else if (r.blueScore > r.redScore)  matchWinner = "blue";

    const allDraws = r.drawRounds === r.currentRound;

    [
        { side: "red",  team: r.red  },
        { side: "blue", team: r.blue },
    ].forEach(({ side, team }) => {
        if (!team || !globalTeams[team.id]) return;
        const gt = globalTeams[team.id];
        gt.matchesPlayed++;
        if (!allDraws) gt.totalInTime += r[side + "RoundTime"];
        gt.avgTime = gt.matchesPlayed > 0
            ? gt.totalInTime / gt.matchesPlayed : 0;
        if (matchWinner === side) gt.matchesWon++;
        recalcScore(gt);
    });

    io.emit("update-leaderboard", globalTeams);

    io.to(room).emit("match-over", {
        draw:       matchWinner === null,
        winner:     matchWinner,
        winnerName: matchWinner ? r[matchWinner].name : null,
        redScore:   r.redScore,
        blueScore:  r.blueScore,
        redName:    r.red.name,
        blueName:   r.blue.name,
        inTime:     Math.max(r.redRoundTime, r.blueRoundTime),
    });
}

// ─────────────────────────────────────────────
//  Socket Handlers
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
    socket.emit("update-leaderboard", globalTeams);

    // ── Hub: Create Team ─────────────────────────────────────────
    socket.on("hub-create-team", (data) => {
        if (!data.name || !data.name.trim()) return;
        const id = makeID();
        globalTeams[id] = {
            id,
            name:          data.name.trim(),
            matchesWon:    0,
            matchesPlayed: 0,
            totalInTime:   0,
            totalAnswers:  0,
            avgTime:       0,
            score:         0,
        };
        io.emit("update-leaderboard", globalTeams);
        socket.emit("team-created", { id, name: data.name.trim() });
    });

    // ── Hub: Delete Team ─────────────────────────────────────────
    socket.on("hub-delete-team", (data) => {
        const id       = typeof data === "string" ? data : data.id;
        const password = typeof data === "string" ? null  : data.password;

        if (password !== ADMIN_PASSWORD) {
            return socket.emit("delete-response", {
                success: false,
                message: "Incorrect password.",
            });
        }
        if (!globalTeams[id]) {
            return socket.emit("delete-response", {
                success: false,
                message: "Team not found.",
            });
        }
        delete globalTeams[id];
        io.emit("update-leaderboard", globalTeams);
        socket.emit("delete-response", { success: true, id });
    });

    // ── Arena: Join ──────────────────────────────────────────────
    socket.on("join-attempt", (data) => {
        const { room, teamID, playerName } = data;

        if (!globalTeams[teamID]) {
            return socket.emit("join-response", {
                success: false,
                message: "Team ID not found. Create your team in the Hub first.",
            });
        }
        if (!playerName || !playerName.trim()) {
            return socket.emit("join-response", {
                success: false,
                message: "Please enter a player name.",
            });
        }

        if (!activeRooms[room]) {
            activeRooms[room] = {
                red:            null,
                blue:           null,
                players:        [],
                ropeX:          0,
                redScore:       0,
                blueScore:      0,
                currentRound:   0,
                drawRounds:     0,
                roundActive:    false,
                roundStartTime: null,
                redRoundTime:   0,
                blueRoundTime:  0,
                timerInterval:  null,
                redQ:           null,
                blueQ:          null,
                matchOver:      false,
                redUnanswered:  0,
                blueUnanswered: 0,
                currentTheme:   null,
                playedThemes:   [],  // grows each round
                votes:          {},
            };
        }

        const r = activeRooms[room];

        if (r.matchOver) {
            return socket.emit("join-response", {
                success: false,
                message: "This match has ended. Please use a new room.",
            });
        }
        if (r.players.find(p => p.socketId === socket.id)) {
            return socket.emit("join-response", {
                success: false,
                message: "You are already in this room.",
            });
        }

        let side = null;
        if      (r.red  && r.red.id  === teamID) side = "red";
        else if (r.blue && r.blue.id === teamID) side = "blue";
        else if (!r.red)  { r.red  = globalTeams[teamID]; side = "red";  }
        else if (!r.blue) { r.blue = globalTeams[teamID]; side = "blue"; }

        if (!side) {
            return socket.emit("join-response", {
                success: false,
                message: "Room full — two teams already registered.",
            });
        }

        const sideCount = r.players.filter(p => p.side === side).length;
        if (sideCount >= MAX_PER_SIDE) {
            return socket.emit("join-response", {
                success: false,
                message: `${side} team is full (max ${MAX_PER_SIDE} players).`,
            });
        }

        socket.join(room);
        socket.roomID     = room;
        socket.side       = side;
        socket.playerName = playerName.trim();

        r.players.push({
            socketId:   socket.id,
            side,
            playerName: playerName.trim(),
            ready:      false,
            votedTheme: null,       // null until they vote
        });

        const available = getAvailableThemes(r);

        socket.emit("join-response", {
            success:         true,
            side,
            redName:         r.red  ? r.red.name  : "Waiting...",
            blueName:        r.blue ? r.blue.name : "Waiting...",
            availableThemes: available,
            themeEmojis:     THEME_EMOJI,
        });

        io.to(room).emit("lobby-update", buildPlayerLists(r));
    });

    // ── Arena: Vote for theme ────────────────────────────────────
    socket.on("vote-theme", (data) => {
        const r = activeRooms[socket.roomID];
        if (!r || r.roundActive || r.matchOver) return;

        const { theme } = data;
        const available = getAvailableThemes(r);

        // Validate theme is one of the available ones
        if (!available.includes(theme)) return;

        const p = r.players.find(p => p.socketId === socket.id);
        if (!p) return;

        // Allow changing vote before readying
        if (p.ready) return;   // locked in once ready

        p.votedTheme = theme;

        // Broadcast updated tally to everyone in room
        io.to(socket.roomID).emit("vote-update", {
            tally:           tallyVotes(r),
            availableThemes: available,
            playerVotes:     buildVoteMap(r),
        });

        io.to(socket.roomID).emit("lobby-update", buildPlayerLists(r));
    });

    // ── Arena: Ready ─────────────────────────────────────────────
    socket.on("player-ready", () => {
        const r = activeRooms[socket.roomID];
        if (!r || r.roundActive || r.matchOver) return;

        const p = r.players.find(p => p.socketId === socket.id);
        if (!p || p.ready) return;

        // Block ready if they haven't voted yet
        if (!p.votedTheme) {
            socket.emit("ready-blocked", {
                message: "Vote for a theme first!",
            });
            return;
        }

        p.ready = true;
        io.to(socket.roomID).emit("lobby-update", buildPlayerLists(r));

        if (allReadyAndVoted(r)) {
            setTimeout(() => startRound(socket.roomID), 1000);
        }
    });

    // ── Arena: Pull ──────────────────────────────────────────────
    socket.on("pull", () => {
        const r = activeRooms[socket.roomID];
        if (!r || !r.roundActive) return;

        const side    = socket.side;
        const oppSide = side === "red" ? "blue" : "red";
        const teamRef = r[side];

        r.ropeX += side === "red" ? -PULL_STRENGTH : PULL_STRENGTH;
        io.to(socket.roomID).emit("rope-moved", { ropeX: r.ropeX });

        if (teamRef && globalTeams[teamRef.id]) {
            globalTeams[teamRef.id].totalAnswers++;
            recalcScore(globalTeams[teamRef.id]);
            io.emit("update-leaderboard", globalTeams);
        }

        r[side + "Q"] = getRandQ(
            r.currentTheme,
            r[side + "Q"] ? r[side + "Q"].q : null
        );
        sendQuestionToSide(socket.roomID, side);

        r[side + "Unanswered"]    = 0;
        r[oppSide + "Unanswered"]++;

        if (r[oppSide + "Unanswered"] >= UNANSWERED_LIMIT) {
            r[oppSide + "Q"] = getRandQ(
                r.currentTheme,
                r[oppSide + "Q"] ? r[oppSide + "Q"].q : null
            );
            sendQuestionToSide(socket.roomID, oppSide);
            r[oppSide + "Unanswered"] = 0;

            r.players
                .filter(p => p.side === oppSide)
                .forEach(p => io.to(p.socketId).emit("question-skipped", {}));
        }

        if (Math.abs(r.ropeX) >= WIN_LIMIT) {
            handleRoundWin(socket.roomID, r.ropeX < 0 ? "red" : "blue");
        }
    });

    // ── Disconnect ───────────────────────────────────────────────
    socket.on("disconnect", () => {
        const room = socket.roomID;
        if (!room || !activeRooms[room]) return;

        const r = activeRooms[room];
        r.players = r.players.filter(p => p.socketId !== socket.id);

        if (r.players.length === 0) {
            clearInterval(r.timerInterval);
            delete activeRooms[room];
            return;
        }

        io.to(room).emit("lobby-update", buildPlayerLists(r));

        const redCount  = r.players.filter(p => p.side === "red").length;
        const blueCount = r.players.filter(p => p.side === "blue").length;

        if (r.roundActive && (redCount === 0 || blueCount === 0)) {
            r.roundActive = false;
            clearInterval(r.timerInterval);
            io.to(room).emit("match-paused", {
                message: redCount === 0
                    ? `${r.red.name} has no players left.`
                    : `${r.blue.name} has no players left.`,
            });
        }
    });
});

// Per-player vote map for client (socketId → theme)
// Only sends side info, not socket IDs
function buildVoteMap(r) {
    const map = {};
    r.players.forEach(p => {
        map[p.socketId] = p.votedTheme;
    });
    return map;
}

httpServer.listen(7860);

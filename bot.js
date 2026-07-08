require('dotenv').config();
const tmi = require('tmi.js');

// Parse authorized users from environment variable
const AUTHORIZED_USERS = process.env.AUTHORIZED_USERS 
    ? process.env.AUTHORIZED_USERS.split(',').map(user => user.trim().toLowerCase())
    : [];

// Auto-posting variables
let autoPostInterval;
let isAutoPostingEnabled = false;

// AI Chat variables
let aiEnabled = true; //enabled by default
const aiCooldowns = new Map();
const AI_COOLDOWN_TIME = 10000; // 10 seconds between AI requests per user

const config = {
    identity: {
        username: process.env.BOT_USERNAME,
        password: process.env.OAUTH_TOKEN
    },
    channels: [process.env.CHANNEL_NAME]
};

const client = new tmi.Client(config);

// Command cooldowns to prevent spam
const commandCooldowns = new Map();

// Helper function to check if user is authorized admin
const isAuthorizedAdmin = (userstate) => {
    return AUTHORIZED_USERS.includes(userstate.username.toLowerCase());
};

// Function to check if user is a moderator
const isModerator = (userstate) => {
    return userstate.mod || userstate.badges?.broadcaster || isAuthorizedAdmin(userstate);
};

// Function to start auto-posting socials
const startAutoPosting = (channel) => {
    if (autoPostInterval) {
        clearInterval(autoPostInterval);
    }
    
    isAutoPostingEnabled = true;
    console.log('🔄 Auto-posting socials enabled (every 10 minutes)');
    
    autoPostInterval = setInterval(() => {
        if (isAutoPostingEnabled) {
            const socialsMessage = `🔗 Follow us! Discord: ${process.env.DISCORD_INVITE} | Twitter: ${process.env.TWITTER_HANDLE} | Follow the stream! 🎯 | Youtube: ${process.env.YOUTUBE_CHANNEL}`;
            client.say(channel, socialsMessage);
            console.log('📢 Auto-posted socials message');
        }
    }, 10 * 60 * 1000); // 10 minutes in milliseconds
};

// Function to stop auto-posting
const stopAutoPosting = () => {
    if (autoPostInterval) {
        clearInterval(autoPostInterval);
        autoPostInterval = null;
    }
    isAutoPostingEnabled = false;
    console.log('⏹️ Auto-posting socials disabled');
};

// AI Chat function using Gemini API (OpenAI-compatible endpoint)
const askAI = async (question, username) => {
    if (!process.env.GEMINI_API_KEY) {
        return "❌ AI not configured. Missing API key.";
    }

    try {
        const response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GEMINI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gemini-3-flash-preview',
                reasoning_effort: 'low',   // it's a thinking model; keep it snappy
                messages: [
                    {
                        role: 'system',
                        content: `You are a helpful Twitch chat assistant named Lil Chef. Keep responses under 200 characters and friendly. You're helping ${process.env.CHANNEL_NAME}'s community. Be concise, helpful, intelligent, and engaging. You are speaking with mostly adults, so no need for any type of odd slang. You do not need to introduce yourself.`
                    },
                    {
                        role: 'user',
                        content: question
                    }
                ],
                max_tokens: 400,
                temperature: 0.7
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0] && data.choices[0].message) {
            let aiResponse = data.choices[0].message.content.trim();
            
            // Truncate if too long for Twitch (500 char limit)
            if (aiResponse.length > 450) {
                aiResponse = aiResponse.substring(0, 447) + '...';
            }
            
            return `👨🏻‍🍳 @${username}: ${aiResponse}`;
        } else {
            return `❌ @${username}, LilChef is having trouble right now. Try cooking again later!`;
        }
    } catch (error) {
        console.error('AI Error:', error);
        return `❌ @${username}, LilChef failed to cook. Try again later!`;
    }
};

// Commands that work without streamer account access
const commands = {
    '!hello': (channel, userstate) => {
        const greetings = [
            `Hello @${userstate.username}! Welcome to the stream! 👋`,
            `Hey there @${userstate.username}! Glad you're here! 🎉`,
            `Welcome @${userstate.username}! Hope you enjoy the stream! ✨`,
            `@${userstate.username} just entered the chat! What's good? 🔥`
        ];
        return greetings[Math.floor(Math.random() * greetings.length)];
    },
    '!dice': (channel, userstate) => {
        const roll = Math.floor(Math.random() * 6) + 1;
        return `🎲 @${userstate.username} rolled a ${roll}!`;
    },
    '!time': (channel, userstate) => {
        return `⏰ Current time: ${new Date().toLocaleTimeString()}`;
    },
    
    '!socials': (channel, userstate) => {
        return `🔗 Follow us! Discord: ${process.env.DISCORD_INVITE} | Twitter: ${process.env.TWITTER_HANDLE} | Follow the stream! 🎯 | Youtube: ${process.env.YOUTUBE_CHANNEL}`;
    },
    '!prime': (channel, userstate) => {
        return `🎮 Amazon Prime members get a FREE Twitch subscription every month! Don't forget to claim yours and maybe support your favorite 👨🏻‍🍳? (We'd be honored 🙏) 💜 Manage your Prime Gaming benefits: https://gaming.amazon.com/links/twitch/manage`;
    },
    
    '!commands': (channel, userstate) => {
        return `Available commands: !chefbot, !rules, !hello, !dice, !8ball, !flip, !rng, !lurk, !unlurk, !hug, !quote, !fact, !time, !botuptime, !love, !vibes, !energy, !discord, !socials, !prime`;
    },
    '!discord': (channel, userstate) => {
        const now = Date.now();
        const cooldownTime = 30000; // 30 seconds
        const lastUsed = commandCooldowns.get('discord') || 0;
        
        if (now - lastUsed < cooldownTime) {
            return null; // Don't respond during cooldown
        }
        
        commandCooldowns.set('discord', now);
        return `🎮 Join our Discord community: ${process.env.DISCORD_INVITE} - See you there @${userstate.username}! 🧑🏻‍🍳`;
    },
    '!8ball': (channel, userstate, args) => {
        if (args.length === 0) {
            return `🎱 @${userstate.username}, ask me a question! Usage: !8ball <question>`;
        }
        const responses = [
            "It is certain", "Reply hazy, try again", "Don't count on it",
            "It is decidedly so", "Ask again later", "My reply is no",
            "Without a doubt", "Better not tell you now", "My sources say no",
            "Yes definitely", "Cannot predict now", "Outlook not so good",
            "You may rely on it", "Concentrate and ask again", "Very doubtful",
            "As I see it, yes", "Most likely", "Outlook good", "Yes", "Signs point to yes"
        ];
        const response = responses[Math.floor(Math.random() * responses.length)];
        return `🎱 @${userstate.username}: "${response}"`;
    },
    '!flip': (channel, userstate) => {
        const result = Math.random() < 0.5 ? 'Heads' : 'Tails';
        const emoji = result === 'Heads' ? '🪙' : '🥇';
        return `${emoji} @${userstate.username} flipped ${result}!`;
    },
    '!rng': (channel, userstate, args) => {
        let min = 1, max = 100;
        if (args.length === 1) {
            max = parseInt(args[0]) || 100;
        } else if (args.length === 2) {
            min = parseInt(args[0]) || 1;
            max = parseInt(args[1]) || 100;
        }
        if (min >= max) {
            return `❌ @${userstate.username}, minimum must be less than maximum!`;
        }
        const result = Math.floor(Math.random() * (max - min + 1)) + min;
        return `🎯 @${userstate.username}: Random number between ${min}-${max} is **${result}**`;
    },
    '!lurk': (channel, userstate) => {
        const messages = [
            `Thanks for lurking @${userstate.username}! Enjoy the stream! 👻`,
            `Happy lurking @${userstate.username}! 🕵️`,
            `@${userstate.username} is now in lurk mode! 🥷`,
            `Lurk away @${userstate.username}! We appreciate you being here! 💜`
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    },
    '!unlurk': (channel, userstate) => {
        const messages = [
            `Welcome back @${userstate.username}! 🎉`,
            `@${userstate.username} has emerged from the shadows! 👋`,
            `Look who's back! Hey @${userstate.username}! ✨`,
            `@${userstate.username} decided to join the conversation! 🗣️`
        ];
        return messages[Math.floor(Math.random() * messages.length)];
    },
    '!hug': (channel, userstate, args) => {
        if (args.length === 0) {
            return `🫂 @${userstate.username} gives everyone a big hug!`;
        }
        const target = args[0].replace('@', '');
        return `🫂 @${userstate.username} gives @${target} a warm hug!`;
    },
    '!quote': (channel, userstate) => {
        const quotes = [
            "The only way to do great work is to love what you do. - Steve Jobs",
            "Innovation distinguishes between a leader and a follower. - Steve Jobs",
            "Stay hungry, stay foolish. - Steve Jobs",
            "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
            "It is during our darkest moments that we must focus to see the light. - Aristotle",
            "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
            "The only impossible journey is the one you never begin. - Tony Robbins",
            "Life is what happens to you while you're busy making other plans. - John Lennon"
        ];
        const quote = quotes[Math.floor(Math.random() * quotes.length)];
        return `💭 ${quote}`;
    },
    '!fact': (channel, userstate) => {
        const facts = [
            "Honey never spoils! Archaeologists have found edible honey in Egyptian tombs.",
            "A group of flamingos is called a 'flamboyance'.",
            "Octopuses have three hearts and blue blood.",
            "Bananas are berries, but strawberries aren't.",
            "A shrimp's heart is in its head.",
            "Wombat poop is cube-shaped.",
            "The shortest war in history lasted only 38-45 minutes.",
            "Cleopatra lived closer in time to the moon landing than to the construction of the Great Pyramid."
        ];
        const fact = facts[Math.floor(Math.random() * facts.length)];
        return `🧠 Fun Fact: ${fact}`;
    },
    '!love': (channel, userstate, args) => {
        if (args.length === 0) {
            const percentage = Math.floor(Math.random() * 101);
            return `💕 @${userstate.username}, you are ${percentage}% loveable today!`;
        }
        const target = args[0].replace('@', '');
        const percentage = Math.floor(Math.random() * 101);
        return `💕 Love between @${userstate.username} and @${target}: ${percentage}%`;
    },
    '!botuptime': (channel, userstate) => {
        const uptimeSeconds = Math.floor(process.uptime());
        const hours = Math.floor(uptimeSeconds / 3600);
        const minutes = Math.floor((uptimeSeconds % 3600) / 60);
        const seconds = uptimeSeconds % 60;
        return `🧑🏻‍🍳 Bot has been awake for: ${hours}h ${minutes}m ${seconds}s`;
    },
    '!vibes': (channel, userstate) => {
        const vibeChecks = [
            `✨ @${userstate.username} is radiating good vibes today! The energy is immaculate! 🌟`,
            `🔥 @${userstate.username}'s vibe check: ELITE TIER! 💯`,
            `🌈 @${userstate.username} is bringing rainbow energy to the chat! 🦄`,
            `⚡ @${userstate.username}'s vibe frequency: MAXIMUM POWER! 🚀`,
            `😎 @${userstate.username} is too cool for the vibe check! 🧊`,
            `🎵 @${userstate.username} is vibing to life's soundtrack! 🎶`
        ];
        return vibeChecks[Math.floor(Math.random() * vibeChecks.length)];
    },
    '!energy': (channel, userstate) => {
        const energyLevel = Math.floor(Math.random() * 101);
        let emoji, description;
        
        if (energyLevel >= 90) {
            emoji = "⚡🔥⚡";
            description = "MAXIMUM OVERDRIVE!";
        } else if (energyLevel >= 70) {
            emoji = "🚀";
            description = "High energy rocket mode!";
        } else if (energyLevel >= 50) {
            emoji = "✨";
            description = "Steady positive energy!";
        } else if (energyLevel >= 30) {
            emoji = "☕";
            description = "Could use some coffee...";
        } else {
            emoji = "😴";
            description = "Low power mode activated";
        }
        
        return `${emoji} @${userstate.username}'s energy level: ${energyLevel}% - ${description}`;
    },
    '!rules': (channel, userstate) => {
        return `📋 Stream Rules: • Keep language clean • No politics/current events discussion • Backseating permitted as long as it is reasonable 🎯`;
    },
    '!echo': (channel, userstate, args) => {
        const message = args.join(' ');
        return message ? `📢 ${message}` : 'Usage: !echo <message>';
    },
    // AI Chat command
    '!chefbot': async (channel, userstate, args) => {
        if (!aiEnabled) {
            return `🤖 Chef AI chat is currently disabled. Admins can enable it with !ai-toggle`;
        }

        if (args.length === 0) {
            return `👨🏻‍🍳 @${userstate.username}, ask me something, LET ME COOK! Usage: !chefbot <your question>`;
        }

        // Check cooldown
        const now = Date.now();
        const lastUsed = aiCooldowns.get(userstate.username) || 0;
        const timeLeft = AI_COOLDOWN_TIME - (now - lastUsed);
        
        if (timeLeft > 0) {
            return `⏱️ @${userstate.username}, please wait ${Math.ceil(timeLeft / 1000)} seconds before asking again.`;
        }

        // Set cooldown
        aiCooldowns.set(userstate.username, now);

        const question = args.join(' ');
        console.log(`AI request from ${userstate.username}: ${question}`);
        
        try {
            return await askAI(question, userstate.username);
        } catch (error) {
            console.error('AI command error:', error);
            return `❌ @${userstate.username}, Chef AI is having trouble. Try cooking again later!`;
        }
    }
};

// Admin commands for authorized users only
const adminCommands = {
    '!shutdown': (channel, userstate) => {
        client.say(channel, `🔧 Bot shutting down by admin @${userstate.username}...`);
        console.log(`Bot shutdown initiated by: ${userstate.username}`);
        setTimeout(() => process.exit(0), 1000);
        return null;
    },
    
    '!restart': (channel, userstate) => {
        client.say(channel, `🔄 Bot restarting by admin @${userstate.username}...`);
        console.log(`Bot restart initiated by: ${userstate.username}`);
        setTimeout(() => process.exit(1), 1000); // Exit code 1 for restart
        return null;
    },
    
    '!autopost': (channel, userstate, args) => {
        if (args.length === 0) {
            return `🔧 Auto-posting is currently ${isAutoPostingEnabled ? 'enabled' : 'disabled'}. Use !autopost on/off`;
        }
        
        const action = args[0].toLowerCase();
        if (action === 'on' || action === 'enable') {
            startAutoPosting(channel);
            return `✅ Auto-posting socials enabled! Will post every 10 minutes.`;
        } else if (action === 'off' || action === 'disable') {
            stopAutoPosting();
            return `❌ Auto-posting socials disabled.`;
        } else {
            return `❓ Usage: !autopost on/off`;
        }
    },
    
    '!autopost-status': (channel, userstate) => {
        return `📊 Auto-posting status: ${isAutoPostingEnabled ? '✅ Enabled (every 10 minutes)' : '❌ Disabled'}`;
    },
    '!ai-toggle': (channel, userstate) => {
        aiEnabled = !aiEnabled;
        console.log(`AI chat ${aiEnabled ? 'enabled' : 'disabled'} by: ${userstate.username}`);
        return `👨🏻‍🍳 Chef AI chat ${aiEnabled ? 'enabled' : 'disabled'}! ${aiEnabled ? 'Chatters can now use !chefbot <question>' : 'Chef AI commands are now disabled and no longer cooking.'}`;
    },

    '!ai-status': (channel, userstate) => {
        const apiStatus = process.env.GEMINI_API_KEY ? '✅ API key configured' : '❌ No API key';
        return `👨🏻‍🍳 Chef AI Status: ${aiEnabled ? 'Enabled' : 'Disabled'} | ${apiStatus}`;
    },
    
    '!adminhelp': (channel, userstate) => {
        return `🔧 Admin commands: !shutdown, !restart, !autopost, !autopost-status, !adminhelp`;
    }
};

// Mod-only commands
const modCommands = {
    '!timeout': (channel, userstate, args) => {
        if (args.length > 0) {
            return `/timeout ${args[0]} 60`; // 60 second timeout
        }
    },
    
    '!clear': (channel, userstate) => {
        return '/clear';
    },
    '!ban': (channel, userstate, args) => {
        if (args.length === 0) {
            return `❌ @${userstate.username}, usage: !ban <username> [reason]`;
        }
        
        const targetUser = args[0].replace('@', ''); // Remove @ if present
        const reason = args.slice(1).join(' ') || 'No reason provided';
        
        // Log the ban action
        console.log(`🔨 Ban executed by ${userstate.username} on ${targetUser}. Reason: ${reason}`);
        
        // Return the Twitch ban command
        return `/ban ${targetUser} ${reason}`;
    },
    //unban command too
    '!unban': (channel, userstate, args) => {
        if (args.length === 0) {
            return `❌ @${userstate.username}, usage: !unban <username>`;
        }
        
        const targetUser = args[0].replace('@', '');
        
        // Log the unban action
        console.log(`🔓 Unban executed by ${userstate.username} on ${targetUser}`);
        
        return `/unban ${targetUser}`;
    }
};

// Main message handler
client.on('message', async (channel, userstate, message, self) => {
    // Don't respond to the bot's own messages
    if (self) return;
    
    // Log all messages for debugging
    console.log(`[${channel}] ${userstate.username}: ${message}`);
    
    const args = message.split(' ');
    const command = args[0].toLowerCase();
    
    // Check admin commands first
    if (adminCommands[command]) {
        if (isAuthorizedAdmin(userstate)) {
            console.log(`Admin command ${command} executed by: ${userstate.username}`);
            const response = adminCommands[command](channel, userstate, args.slice(1));
            if (response) client.say(channel, response);
        } else {
            console.log(`Unauthorized admin command attempt by: ${userstate.username}`);
            client.say(channel, `❌ @${userstate.username}, admin privileges required for ${command}`);
        }
        return;
    }
    
    // Check moderator commands
    if (modCommands[command]) {
        if (isModerator(userstate)) {
            console.log(`Mod command ${command} executed by: ${userstate.username}`);
            const response = modCommands[command](channel, userstate, args.slice(1));
            if (response) client.say(channel, response);
        } else {
            client.say(channel, `❌ @${userstate.username}, moderator privileges required for ${command}`);
        }
        return;
    }
    
    // Regular commands available to everyone
    if (commands[command]) {
        try {
            let response;
            if (command === '!echo') {
                response = commands[command](channel, userstate, args.slice(1));
            } else {
                response = await commands[command](channel, userstate, args.slice(1));
            }
            
            if (response) {
                console.log(`Command ${command} executed by: ${userstate.username}`);
                client.say(channel, response);
            }
        } catch (error) {
            console.error(`Error executing command ${command}:`, error);
            client.say(channel, `❌ Sorry @${userstate.username}, something went wrong with that command.`);
        }
    }
});

// Connection event handlers
client.on('connected', (address, port) => {
    console.log('='.repeat(50));
    console.log('✅ Twitch Bot Connected Successfully!');
    console.log('='.repeat(50));
    console.log(`🤖 Bot Username: ${process.env.BOT_USERNAME}`);
    console.log(`📺 Channel: ${process.env.CHANNEL_NAME}`);
    console.log(`🔗 Channel URL: https://twitch.tv/${process.env.CHANNEL_NAME}`);
    console.log(`👥 Authorized Admins: ${AUTHORIZED_USERS.join(', ')}`);
    console.log(`🎮 Discord: ${process.env.DISCORD_INVITE || 'Not set'}`);
    console.log(`🤖 AI Chat: ${process.env.GEMINI_API_KEY ? 'Configured' : 'Not configured'} (${aiEnabled ? 'Enabled' : 'Disabled'})`);
    console.log('='.repeat(50));
    console.log('💬 Bot is ready for commands!');
    console.log('Type !commands in chat to see available commands');
    console.log('='.repeat(50));
    
    // Auto-posting is disabled by default - use !autopost on to enable
    console.log('📢 Auto-posting socials is DISABLED by default. Use !autopost on to enable.');
});

client.on('disconnected', (reason) => {
    console.log(`❌ Bot Disconnected: ${reason}`);
});

client.on('reconnect', () => {
    console.log('🔄 Bot Reconnecting...');
});

client.on('join', (channel, username, self) => {
    if (self) {
        console.log(`🎯 Bot joined channel: ${channel}`);
    }
});

// Error handling
client.on('error', (error) => {
    console.error('❌ Bot Error:', error);
});

// Environment variable validation
console.log('🔍 Checking environment variables...');
const requiredVars = ['BOT_USERNAME', 'OAUTH_TOKEN', 'CHANNEL_NAME'];
const missingVars = requiredVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ Missing required environment variables:', missingVars.join(', '));
    console.error('Please check your .env file');
    process.exit(1);
}

if (AUTHORIZED_USERS.length === 0) {
    console.warn('⚠️  No authorized admin users set. Admin commands will be disabled.');
}

if (!process.env.GEMINI_API_KEY) {
    console.warn('⚠️  GEMINI_API_KEY not set. AI features will be disabled.');
}

console.log('✅ Environment variables validated');

// Preflight: verify outbound HTTPS to Twitch + token validity before opening chat socket
const preflight = async () => {
    try {
        const token = (process.env.OAUTH_TOKEN || '').replace(/^oauth:/, '');
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `OAuth ${token}` }
        });
        if (res.ok) {
            const info = await res.json();
            console.log(`✅ Preflight OK — HTTPS to Twitch works, token valid for "${info.login}"`);
        } else {
            console.error(`⚠️ Preflight: reached Twitch, but token validation returned HTTP ${res.status} — token may be expired/revoked, regenerate it`);
        }
    } catch (err) {
        console.error(`❌ Preflight: cannot reach Twitch over HTTPS at all — host network/egress issue: ${err.message}`);
    }
};

// Connect to Twitch
preflight().finally(() => {
    console.log('🔌 Connecting to Twitch...');
    client.connect().catch((error) => {
        console.error('❌ Failed to connect to Twitch:', error);
        process.exit(1);
    });
});

// Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    stopAutoPosting();
    client.disconnect();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    stopAutoPosting();
    client.disconnect();
    process.exit(0);
});
# 🤖 Custom Twitch Bot for roguedubz 🧑🏻‍🍳

A unique, personality-driven Twitch chat bot designed to complement StreamElements with custom commands and enhanced viewer interactions.

## ✨ Features

### 🤖 AI Chat Integration
- **Interactive AI Assistant** - Ask questions and get intelligent responses
- **Smart Cooldown System** - Prevents spam while maintaining responsiveness
- **Admin Controls** - Enable/disable AI features as needed

### 🎮 Interactive Commands
- **Magic 8-Ball** - Ask questions and get mystical answers
- **Custom Dice** - Roll dice with customizable sides (1-100)
- **RNG Generator** - Random numbers with custom ranges
- **Coin Flip** - Classic heads or tails
- **Vibe Check** - Check your current vibe levels
- **Energy Meter** - See your energy percentage with descriptions

### 💬 Social Commands
- **Enhanced Greetings** - Multiple welcome message variations
- **Lurk/Unlurk** - Stylish lurker appreciation
- **Virtual Hugs** - Spread the love with different hug styles
- **Love Calculator** - Check compatibility percentages
- **Vanish Effects** - Disappear in style with magical effects

### 📚 Educational & Fun
- **Random Quotes** - Inspirational quotes for motivation
- **Fun Facts** - Learn interesting trivia
- **Social Links** - Easy access to Discord, Twitter, YouTube

### 🛠️ Utility Commands
- **Help System** - Detailed command explanations
- **Time Display** - Current time and date
- **Bot Status** - Uptime and system information

## 🚀 Commands List

| Command | Description | Usage |
|---------|-------------|--------|
| `!chefbot` | Ask the AI assistant | `!chefbot <question>` |
| `!hello` | Random welcome greeting | `!hello` |
| `!dice` | Roll dice (default 6-sided) | `!dice [sides]` |
| `!8ball` | Magic 8-ball responses | `!8ball <question>` |
| `!flip` | Coin flip | `!flip` |
| `!rng` | Random number generator | `!rng [min] [max]` |
| `!vibes` | Check your vibe levels | `!vibes` |
| `!energy` | Check energy percentage | `!energy` |
| `!lurk` | Enter lurk mode | `!lurk` |
| `!unlurk` | Exit lurk mode | `!unlurk` |
| `!hug` | Give virtual hugs | `!hug [@user]` |
| `!love` | Love compatibility | `!love [@user]` |
| `!vanish` | Disappear with style | `!vanish` |
| `!quote` | Random inspirational quote | `!quote` |
| `!fact` | Random fun fact | `!fact` |
| `!discord` | Discord invite link | `!discord` |
| `!socials` | All social media links | `!socials` |
| `!time` | Current time and date | `!time` |
| `!botuptime` | Bot uptime statistics | `!botuptime` |
| `!help` | Command help system | `!help [command]` |
| `!commands` | List all commands | `!commands` |

### 🔧 Admin Commands
| Command | Description | Access |
|---------|-------------|---------|
| `!shutdown` | Safely shutdown bot | Authorized users only |
| `!restart` | Restart bot | Authorized users only |
| `!botinfo` | Detailed bot information | Authorized users only |

### 👮 Moderator Commands
| Command | Description | Access |
|---------|-------------|---------|
| `!timeout` | Timeout a user | Mods/Broadcaster |
| `!clear` | Clear chat | Mods/Broadcaster |

## 🛠️ Technical Details

### Built With
- **Node.js** 18.x
- **tmi.js** - Twitch chat interface
- **dotenv** - Environment variable management

### Architecture
- **Modular command system** with easy extensibility
- **Smart cooldown management** to prevent spam
- **Multiple response variations** for engaging interactions
- **Comprehensive error handling** and logging
- **Environment-based configuration** for security

### Key Features
- ✅ **No API dependencies** - Works immediately without external services
- ✅ **StreamElements compatible** - Won't conflict with existing bots
- ✅ **Personality-driven** - Multiple response variations for each command
- ✅ **Smart cooldowns** - Prevents spam while maintaining responsiveness
- ✅ **Secure admin system** - Environment-variable based authorization
- ✅ **Professional logging** - Comprehensive activity monitoring


## 📋 Setup Instructions

### Prerequisites
- Node.js 18.x or higher
- Twitch bot account
- OAuth token from [TwitchTokenGenerator](https://twitchtokengenerator.com/)

### Local Development
1. **Clone the repository**
   ```bash
   git clone https://github.com/gsurjs/lilchefb0t.git
   cd lilchefb0t
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create .env file**
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

4. **Run the bot**
   ```bash
   npm start
   ```

## 🎯 Design Philosophy

This bot is designed to **complement, not compete** with StreamElements and other popular bot services. It focuses on:

- **Unique personality-driven interactions**
- **Creative and fun commands** not found in standard bots
- **Enhanced social features** with multiple response variations
- **Zero conflicts** with existing bot systems
- **Easy extensibility** for custom features

## 📊 Analytics & Monitoring

The bot includes comprehensive logging for:
- Command usage statistics
- User interaction patterns
- Error tracking and debugging
- Performance monitoring
- Admin action auditing

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

### Development Guidelines
- Follow existing code style and structure
- Add appropriate comments for new features
- Test commands thoroughly before submitting
- Update README if adding new commands

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **tmi.js** - Excellent Twitch chat library
- **Railway** - Seamless deployment platform
- **roguedubz** - Awesome streamer and Executive Chef
- **Twitch community** - Inspiration for fun commands

---

## 🎮 Live Bot

This bot is currently active in the **roguedubz** Twitch channel!

**Try it out**: Visit [twitch.tv/roguedubz](https://twitch.tv/roguedubz) and use `!commands` to see all available features.

---

*Made with ❤️ for the roguedubz streaming community*
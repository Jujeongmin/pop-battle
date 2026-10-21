# Agent8 GameServer

Build and run game server logic safely using TypeScript with Agent8 GameServer.

## ⚙️ Requirements

- **Node.js 22** (recommended)
- npm or yarn

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npx -y @agent8/gameserver-node init
```

### 2. Write Server Code

Write your server logic in `server/src/server.ts`:

```typescript
export class Server {
  async ping(): Promise<string> {
    return 'pong';
  }

  async getMyAccount(): Promise<string> {
    return $sender.account;
  }

  async updateScore(points: number): Promise<number> {
    const myState = await $global.getMyState();
    const newScore = (myState.score || 0) + points;
    await $global.updateMyState({ score: newScore });
    return newScore;
  }
}
```

### 3. Build

```bash
cd server
npm run build
# or
npx -y @agent8/gameserver-node build
# for debugging : npx -y @agent8/gameserver-node build --no-minify
```

### 4. Test

```bash
cd server
npm test
# or
npx -y @agent8/gameserver-node test
# for debugging : npx -y @agent8/gameserver-node test --no-minify
```

### 5. Development Server (REPL)

Test your functions instantly with the interactive development server:

```bash
cd server
npm run dev
# or
npx -y @agent8/gameserver-node dev
# for debugging : npx -y @agent8/gameserver-node dev --no-minify 
```

Available commands in dev server:
```bash
> ping()                              # Call function
> updateScore(100);                   # Semicolon supported
> greet('Alice')                      # Single quotes supported

> $sender                             # Show current sender context
> server.connect({ account: "alice" }) # Change sender context

> help                                # List available functions
> exit                                # Exit
```

## 📚 Available Contexts

The following global variables are available in your server code:

### `$sender`
Current request sender information:
```typescript
$sender.account      // User account address
$sender.roomId       // Current room ID
$sender.isFollower   // Follower status
```

### `$global`
Global state management:
```typescript
await $global.getState(key)
await $global.setState(key, value)
await $global.getMyState()
await $global.updateMyState(updates)
await $global.getUserState(account)
// ... more methods
```

### `$room`
Room state management:
```typescript
await $room.getState(key)
await $room.setState(key, value)
await $room.getMyState()
await $room.updateMyState(updates)
// ... more methods
```

### `$asset`
Asset management:
```typescript
await $asset.getAll()
await $asset.get(ticker)
// ... more methods
```

## ⚠️ Important Limitations

### Isolated VM Environment

Your server code runs in an **isolated-vm** environment for security and performance. This comes with certain limitations:

### ✅ Available
- Provided contexts: `$sender`, `$global`, `$room`, `$asset`
- Pure JavaScript/TypeScript libraries (lodash, date-fns, etc.)
- Most computation and logic processing

### ❌ Not Available
- Node.js built-in modules: `fs`, `http`, `https`, `net`, `child_process`, etc.
- Network request libraries: `axios`, `node-fetch`, etc. (with some exceptions)
- File system access
- External process execution

### 📦 Using External Libraries

You can install and use simple libraries via npm:

```bash
npm install lodash crypto-js
```

```typescript
import _ from 'lodash';
import CryptoJS from 'crypto-js';

export class Server {
  async hash(message: string): Promise<string> {
    return CryptoJS.SHA256(message).toString();
  }
  
  async shuffle(items: any[]): Promise<any[]> {
    return _.shuffle(items);
  }
}
```

### ⚡ Importance of Testing

Due to isolated-vm environment constraints, some code may not work as expected.

**Always run tests after writing code:**

```bash
cd
npm test
```

Tests must pass for production deployment.

## 📖 Documentation

For more information, see:

- **User Documentation**: https://docs.verse8.io/
- **AI Developer Documentation**: https://docs.verse8.io/skills/gameserver-node

## 🛠 Available Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Production build (with minification) |
| `npm run build:dev` | Development build (without minification, easier debugging) |
| `npm run watch` | Watch mode with auto-rebuild |
| `npm test` | Run tests |
| `npm run test:dev` | Run tests (without minification) |
| `npm run dev` | Start development server (REPL) |
| `npm run dev:readable` | Start development server (without minification) |

## 📝 Example Code

### Score System
```typescript
export class Server {
  async getScore(): Promise<number> {
    const state = await $global.getMyState();
    return state.score || 0;
  }

  async addScore(points: number): Promise<number> {
    const currentScore = await this.getScore();
    const newScore = currentScore + points;
    await $global.updateMyState({ score: newScore });
    return newScore;
  }
}
```

### Room Lifecycle Hooks
```typescript
export class Server {
  // Room join/leave is managed by the platform (WebSocket connections).
  // Implement lifecycle hooks to react to room events:
  async onRoomCreate(roomId: string): Promise<void> {
    await $room.updateRoomState({ status: 'WAITING', createdAt: Date.now() });
  }

  async onRoomJoin(roomId: string, account: string): Promise<void> {
    console.log(`${account} joined room ${roomId}`);
  }

  async onRoomLeave(roomId: string, account: string): Promise<void> {
    console.log(`${account} left room ${roomId}`);
  }
}
```

### Inventory Management
```typescript
export class Server {
  async getMyInventory(): Promise<any[]> {
    const state = await $global.getMyState();
    return state.inventory || [];
  }

  async addItem(item: string): Promise<void> {
    const inventory = await this.getMyInventory();
    inventory.push({ item, timestamp: Date.now() });
    await $global.updateMyState({ inventory });
  }
}
```

## 🐛 Troubleshooting

### Build Fails
- Check for TypeScript type errors
- Verify you're not importing unsupported Node.js modules

### Test Fails
- Check if you're using features not supported by isolated-vm
- Verify you're not attempting network requests or file system access

---

**Happy Coding! 🎮**

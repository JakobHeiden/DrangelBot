const Discord = require('discord.js');
const client = new Discord.Client();
const auth = require('./auth.json');
const fs = require('fs');
const snekfetch = require('snekfetch');
const config = require('./config.json');
//TODO map vs set TODO log
let games;
let debugModeChannel;

//client behavior
client.on('ready', () => {
	if (!fs.existsSync('games.dat')) {
		games = new Map([]);
		console.log('games.dat not found, generating empty games.dat');
		saveGames();
	} else {
		fs.readFile('games.dat', 'utf8', (err, data) => {
			if (err) throw err;
			try {
				games = gamesFromString(data);
				console.log(games);
			} catch(err) {
				console.log('Error parsing JSON string:', err);
			}
		});
	}
	console.log('logged in as ${client.user.tag}!');
	console.log(config.messageMode);
	if (config.messageMode === "debug") {
		client.fetchUser(config.debugUserId)
		.then(debugUser => debugUser.createDM())
		.then(debugDM => debugModeChannel = debugDM)
		.catch(console.log);
	}
	setInterval(tick, 1000*60*1);//start core loop
	setInterval(decay, 1000*60*60*24);//increment decayCounter once a day
});

client.on('message', msg => {
	if (msg.content.startsWith(config.commandPrefix)) {
		let split = msg.content.substr(config.commandPrefix.length).split(' ');
		let command = split[0];
		let args = split.slice(1, split.length);
		if (command === 'help') {
			help(msg);
		} else if (command === 'register') {
			register(msg, args);
		} else if (command === 'unregister') {
			unregister(msg);
		} else if (command === 'claim') {
			claim(msg, args);
		}	else if (command === 'unclaim') {
			unclaim(msg);
		}	else if (command === 'admin') {
			admin(msg);
		} else if (command === 'time' || command === 'timer') {
			time(msg);
		} else if (command === 'silent') {
			silent(msg);
		} else if (command === 'broadcast') {
			broadcast(msg);
		} else {
			msg.channel.send('unknown command. Use ' + config.commandPrefix + 'help for a list of all commands');
		}
	}
});

client.login(auth.token);

//core loop and associated functions, also game decay
function tick() {
	console.log('tick');
	for (let g of games) {
		let game = g[1];
		getLlamaString(game.name)
		.then(llamastring => {
			let llData = new LlamaData(llamastring);
			notifyLate(game, llData);
			notifyLast(game, llData);
			checkNewTurn(game, llData);
		})
		.then(saveGames)
		.catch(console.log);
	}
}

function notifyLate(game, llData) {
	let minsLeft = llData.minsLeft;
	//determine who needs to be notified
	let toNotify = new Set();
	let toNotifyUrgent = new Set();
	for (let p of game.players) {
		let player = p[1];
		if (llData.nations.get(player.nation) == false || player.isAdmin) {
			if (minsLeft <= config.timerLong && !player.isNotified) {
				toNotify.add(player);
			}
			if (minsLeft <= config.timerShort && !player.isNotifiedUrgent) {
				toNotifyUrgent.add(player);
			}
		}
		//reset flags if appropriate
		if (minsLeft > config.timerLong) player.isNotified = false;
		if (minsLeft > config.timerShort) player.isNotifiedUrgent = false;
	}
	//console.log(toNotify);
	//notify these people
	let channel = client.channels.get(game.channelId);
	if (toNotify.size > 0) {
		if (game.silentMode) {
			for (let player of toNotify) {
				client.fetchUser(player.id)
				.then(user => user.createDM())
				.then(dm => send(dm, '' + config.timerLong + ' minutes left in ' + game.name));
			}
		} else {
			let toSend = '';
			for (let player of toNotify) {
				toSend += '<@' + player.id + '>, ';
			}
			toSend += config.timerLong + ' Minutes left to do your turn';
			send(channel, toSend);
		}
		for (let player of toNotify) {
				player.isNotified = true;
		}
		//saveGames();
	}
	if (toNotifyUrgent.size > 0) {
		if (game.silentMode) {
			for (let player of toNotify) {
				client.fetchUser(player.id)
				.then(user => user.createDM())
				.then(dm => send(dm, '' + config.timerShort + ' minutes left in ' + game.name + '!'));
			}
		} else {
			let toSend = '';
			for (let player of toNotifyUrgent) {
				toSend += '<@' + player.id + '>, ';
			}
			toSend += config.timerShort + ' Minutes left to do your turn!';
			send(channel, toSend);
		}
		for (let player of toNotifyUrgent) {
				player.isNotifiedUrgent = true;
		}
		//saveGames();
	}		
}

function notifyLast(game, llData) {
	let numNationsNotDone = 0;
	let lastNation;
	for (let entry of llData.nations) {
		if (!entry[1]) {
			numNationsNotDone++;
			lastNation = entry[0];
		}
	}
	//console.log('numnationsNotDone ' + numNationsNotDone);
	if (numNationsNotDone == 1) {
		let lastPlayer;
		for (let p of game.players) {
			if (p[1].nation == lastNation) lastPlayer = p[1];
		}
		//console.log(lastPlayer);
		if (lastPlayer != undefined && lastPlayer.isNotifiedLast == false) {
			//console.log('if');
			let channel = client.channels.get(game.channelId);
			if (game.silentMode) {
				client.fetchUser(lastPlayer.id)
				.then(user => user.createDM())
				.then(dm => send(dm, 'Last undone turn in ' + game.name));
			} else {
				send(channel, '<@' + lastPlayer.id + '> last');
			}
			lastPlayer.isNotifiedLast = true;
			//saveGames();
		}
	} else {//reset flags
		for (let p of game.players) {
			p[1].isNotifiedLast = false;
		}
		//saveGames();
	}
}

function checkNewTurn(game, llData) {
	let it = llData.nations.values();
	let nooneHasDoneTheirTurn = true;
	for (let turnDone of it) {
		if (turnDone) nooneHasDoneTheirTurn = false;
	}
	if (nooneHasDoneTheirTurn) {
		if (game.isNotifiedNewTurn == false) {
			let channel = client.channels.get(game.channelId);
			//check for stales, notify channel of stalers
			getStalerString(game.name)
			.then(stalerString => {
				if (stalerString.length > 0) send(channel, stalerString);
				});
			//notify players
			let toNotifyNewTurn = new Set();
			for (let p of game.players) {
				toNotifyNewTurn.add(p[1]);
			}
			if (toNotifyNewTurn.size > 0) {
				if (config.messageMode === 'silent') {
					for (let player of toNotifyNewTurn) {
						client.fetchUser(player.id)
						.then(user => user.createDM())
						.then(dm => send(dm, 'New turn for ' + player.nation + ' in ' + game.name))
						.catch(console.log);
					}
				} else {
					let toSend = '';
					for (let player of toNotifyNewTurn) {
						toSend += '<@' + player.id + '>, ';
					}
					toSend += 'new turn';
					send(channel, toSend);
				}
			}
			game.isNotifiedNewTurn = true;
			//saveGames();
		}
	} else {//somebody has done their turn -> reset the flag for next turn
		game.isNotifiedNewTurn = false;
		//saveGames();
	}	
}

function decay() {
	console.log('decay...');
	for (let g of games) {
		let game = g[1];
		getLlamaString(game.name)
		.catch(() => {
			game.decayCounter++;
			console.log(game.decayCounter);
			if (game.decayCounter > 5) {
				console.log(games);
				games.delete(game.channelId);
				console.log(games);
				console.log(game.name + ' has decayed.');
				saveGames();
			}
		});
	}
}

//command functions
function help(msg) {
	send(msg.channel, 'Commands are:\n' +
	config.commandPrefix + 'register <Llamaserver game>\n' +
	config.commandPrefix + 'unregister\n' +
	config.commandPrefix + 'claim <nation>\n' +
	config.commandPrefix + 'unclaim\n' +
	config.commandPrefix + 'admin\n' +
	config.commandPrefix + 'time\n' +
	config.commandPrefix + 'silent');
}

function register(msg, args) {
	if (args.length == 0) {
		send(msg.channel, `Usage: ${config.commandPrefix}register <name-of-Llamaserver-game>`);
	}	else if (games.has(msg.channel.id)) {
		send(msg.channel, 'This channel already has a game registered. Use ' + config.commandPrefix + 'unregister to remove it');
	} else {
		getLlamaString(args[0])//will throw an error if game page does not exist
		.then(llamastring => {
			game = new Game(msg.channel.id, args[0]);
			games.set(msg.channel.id, game);
			saveGames();
			send(msg.channel, `Game registered. Players can now ${config.commandPrefix}claim`);
		})
		.catch(err => send(msg.channel, err));
	}
}

function unregister(msg) {
	if (!games.has(msg.channel.id)) {
		send(msg.channel, 'No game is registered to this channel. Use ' + config.commandPrefix + 'register to register your game');
	} else {
		games.delete(msg.channel.id);
		send(msg.channel, 'Game deleted from database');
		saveGames();
	}
}

function claim(msg, args) {
	if (!games.has(msg.channel.id)) {
		send(msg.channel, `Game is not registered. Use ${config.commandPrefix}register`);
	} else if (args.length == 0) {
		send(msg.channel, `Usage: ${config.commandPrefix}claim <nation>`);
	} else {
		let game = games.get(msg.channel.id);
		let nation = args[0].charAt(0).toUpperCase() + args[0].slice(1);
		if (game.players.has(msg.author.id)) {
			send(msg.channel, 'You already claimed a nation. Use ' + config.commandPrefix + 'unclaim first if you want to switch');
		} else {
			getLlamaString(game.name)
			.then(llamastring => {
				let llData = new LlamaData(llamastring);
				if (!llData.nations.has(nation)) {
					send(msg.channel, 'This nation is not in the game.');
				}	else {
					let player = new Player(msg.author.id, nation);
					game.players.set(msg.author.id, player);
					saveGames();
					send(msg.channel, `You have claimed the nation ${nation}`);
				}
			})
			.catch(console.log);
		}
	}
}

function unclaim(msg) {
	if (!games.has(msg.channel.id)) {
		send(msg.channel, `Game is not registered. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		if (!game.players.has(msg.author.id)) {
			send(msg.channel, 'You have not yet claimed a nation.');
		} else {
			send(msg.channel, 'You have unclaimed the nation ' + game.players.get(msg.author.id).nation);
			game.players.delete(msg.author.id);
			saveGames();
		}
	}
}

function admin(msg) {
	if (!games.has(msg.channel.id)) {
				send(msg.channel, `Game is not registered. Use ${config.commandPrefix}register`);
	} else {
			let game = games.get(msg.channel.id);
			if (!game.players.has(msg.author.id)) {
				send(msg.channel, `You have not claimed a nation yet. Use ${config.commandPrefix}claim`);
			} else {
				player = game.players.get(msg.author.id);
				if (player.isAdmin) {
					player.isAdmin = false;
					send(msg.channel, 'You are no longer an admin.');
				} else {
					player.isAdmin = true;
					send(msg.channel, 'You are now an admin. You will receive notifications when another player is running out of time');
				}
				saveGames();
			}
	}
}

function time(msg) {
	 if (!games.has(msg.channel.id)) {
		send(msg.channel, `Game is not registered. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		getLlamaString(game.name)
		.then(llamastring => {
			let llData = new LlamaData(llamastring);
			let days = Math.trunc(llData.minsLeft / (60*24));
			let hours = Math.trunc((llData.minsLeft - days*60*24) / 60);
			let mins = llData.minsLeft % 60;
			send(msg.channel, `There are ${days} days ${hours} hours ${mins} minutes left`);
		});
	}
}

function silent(msg) {
	if (!games.has(msg.channel.id)) {
		send(msg.channel, `Game is not registered. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		game.silentMode = !game.silentMode;
		if (game.silentMode) {
			msg.channel.send('Silent mode ON. Player notifications will be sent as direct messages');
		} else {
			msg.channel.send('Silent mode OFF');
		}
		saveGames();
	}
}

function broadcast(msg) {
	if (msg.author.id == config.debugUserId) {
		for (let g of games) {
			let channel = client.channels.get(g[1].channelId);
			send(channel, msg.content.slice(11));
		}
	} else {
		msg.channel.send('Only <@' + config.debugUserId + '> can use this command');
	}
}
	
//auxiliary functions
function getLlamaString(name) {
	let url = 'http://www.llamaserver.net/gameinfo.cgi?game=' + name;
	console.log(url);
	let request = snekfetch.get(url);
	return new Promise((resolve, reject) => request.on('data', data => {
		let llamastring = data.toString();
		if (llamastring.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
			reject('This game does not exist');
		}	else {
			llamastring = llamastring.substr(llamastring.indexOf(name) + name.length);
			resolve(llamastring);
		}
	}));
}

function getStalerString(name) {
	let url = 'http://www.llamaserver.net/doAdminAction.cgi?game=' + name + '&action=showstales';
	let request = snekfetch.get(url);
	return new Promise((resolve, reject) => request.on('data', data => {
		let rawString = data.toString();
		if (rawString.includes("Sorry, this isn't a real game. Have you been messing with my URL?")) {
			reject('This game does not exist');
		}	else {
			let chunks = rawString.split('<tr>');
			chunks.shift();
			chunks.shift();
			let returnString = '';
			for (let chunk of chunks) {
				let snippets = chunk.split('&nbsp');
				if (snippets[snippets.length - 2] === ';Staled') {
					returnString += snippets[1].trim().substr(1) + ', ';
				}
			}
			if (returnString.length > 0) {
				returnString = returnString.substr(0, returnString.length - 2);
				returnString += ' staled';
			}
			resolve(returnString);
		}
	}));
}

function gamesToString(games) {
	let str = '';
	for (let g of games) {
		let game = g[1];
		str += game.channelId + '+' + game.name + '+' + game.silentMode + '+' + game.isNotifiedNewTurn + '+' + game.decayCounter;
		for (let p of game.players) {
			let player = p[1];
			str += '+' + player.id + '-' + player.nation + '-' + player.isAdmin + '-' + player.isNotified + '-' 
				+ player.isNotifiedUrgent + '-' + player.isNotifiedLast;
		}
		str += '\n';
	}
	return str;
}

function gamesFromString(str) {
	let games = new Map();
	let gameStrings = str.split('\n');
		gameStrings.pop();//removes newline at end of str
		for (let gameString of gameStrings) {
			let chunks = gameString.split('+');
			let channelId = chunks.shift();
			let gameName = chunks.shift();
			let silentMode = (chunks.shift() === 'true');
			let isNotifiedNewTurn = (chunks.shift() === 'true');
			let decayCounter = chunks.shift();
			let game = new Game(channelId, gameName, silentMode, isNotifiedNewTurn, decayCounter);
			for (let chunk of chunks) {
				let snippets = chunk.split('-');
				let id = snippets.shift();
				let nation = snippets.shift();
				let isAdmin = (snippets.shift() === 'true');
				let isNotified = (snippets.shift() === 'true');
				let isNotifiedUrgent = (snippets.shift() === 'true');
				let isNotifiedLast = (snippets.shift() === 'true');
				let player = new Player(id, nation, isAdmin, isNotified, isNotifiedUrgent, isNotifiedLast);
				game.players.set(id, player);
			}
			games.set(channelId, game);
		}
	return games;
}

function saveGames() {
	fs.writeFile('games.dat', gamesToString(games), function (err) {
		if (err) throw err;
		console.log('Games saved');
	});
}

function send(channel, message) {
	if (config.messageMode === "debug") {
		debugModeChannel.send(message);
	} else {
		channel.send(message);
	}
}

//Constructors
function LlamaData(str) {
	//determine minsLeft
	let currentYear = new Date().getFullYear();
	let months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
	
	let current = str.substring(str.indexOf('Last updated at') + 16, str.indexOf('<a align="right" href="https://pledgie.com'));
	current = current.split(' ');
	let timeOfDay = current[0];
	let cMonth = months.indexOf(current[4]);
	let cDay = parseInt(current[5].slice(0,-2));
	let cHours = parseInt(timeOfDay.substring(0, 2));
	let cMinutes = parseInt(timeOfDay.substring(3, 5));
	current = new Date(currentYear, cMonth, cDay, cHours, cMinutes);
	
	let due = str.substring(str.indexOf('Next turn due:') + 15, str.indexOf('<br><br><TABLE'));
	due = due.split(' ');
	timeOfDay = due[0];
	let dMonth = months.indexOf(due[4]);
	let dDay = parseInt(due[5].slice(0,-2));
	let dHours = parseInt(timeOfDay.substring(0, 2));
	let dMinutes = parseInt(timeOfDay.substring(3, 5));
	due = new Date(currentYear, dMonth, dDay, dHours, dMinutes);
	if (current > due) due.setFullYear(due.getFullYear() + 1);
	
	this.minsLeft = (due - current) / (1000*60);
	
	//fill a map with the nations in the game and wether they have done their turn
	let nations = new Map();
	let entries = str.split('<tr><td>');
	entries.shift();
	for (let entry of entries) {
		entry = entry.slice(0, entry.indexOf('</td></tr>'));
		entry = entry.split(' ');
		let nation = entry.shift();
		let isDone;
		if (entry.pop() === 'received') {
			isDone = true;
		} else {
			isDone = false;
		}
		nations.set(nation, isDone);
	}
	this.nations = nations;
}

function Game(channelId, name, silentMode = false, isNotifiedNewTurn = false, decayCounter = 0) {
	this.channelId = channelId;
	this.name = name;
	this.silentMode = silentMode;
	this.isNotifiedNewTurn = isNotifiedNewTurn;
	this.players = new Map([]);
	this.decayCounter = decayCounter;
}

function Player(id, nation, admin = false, notified = false, notifiedUrgent = false, notifiedLast = false) {
	this.id = id;
	this.nation = nation;
	this.isAdmin = admin;
	this.isNotified = notified;
	this.isNotifiedUrgent = notifiedUrgent;
	this.isNotifiedLast = notifiedLast;
}
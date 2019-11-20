const Discord = require('discord.js');
const client = new Discord.Client();
const auth = require('./auth.json');
const fs = require('fs');
const snekfetch = require('snekfetch');
const config = require('./config.json');

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
				console.log('Loading games database');
			} catch(err) {
				console.log('Error parsing JSON string:', err);
			}
		});
	}
	console.log('logged in as ${client.user.tag}!');
	console.log(config.messageMode);
	console.log(config.debugUserId);
	if (config.messageMode === "debug") {
		console.log(config.debugUserId);
		client.fetchUser(config.debugUserId)
		.then(debugUser => {
			debugUser.createDM()
			.then(debugUserChannel => debugModeChannel = debugUserChannel);
		})
		.then(() => debugModeChannel.send('hurra'))
		.catch(console.log);
	}
	
	setInterval(tick, 1000*60*1);//start core loop
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
		} else if (command === 'claim') {
			claim(msg, args);
		}	else if (command === 'unclaim') {
			unclaim(msg);
		}	else if (command === 'admin') {
			admin(msg);
		} else if (command === 'time' || command === 'timer') {
			time(msg);
		}
	}
});

client.login(auth.token);


//core loop
function tick() {
	console.log('tick');
	for (g of games) {
		let game = g[1];
		getLlamaString(game.name)
		.then(llamastring => {
			let due = llamastring.substring(llamastring.indexOf('Next turn due:') + 15, llamastring.indexOf('<br><br><TABLE'));
			let current = llamastring.substring(llamastring.indexOf('Last updated at') + 16, 
				llamastring.indexOf('<a align="right" href="https://pledgie.com'));
			let minsLeft = compareDates(current, due);
			let channel = client.channels.get(game.channelId);
			//console.log('llamastring ' + llamastring);
			console.log(minsLeft);
			//Notifications for those who are running late
			let notify = new Set();
			let notifyUrgent = new Set();
			for (p of game.players) {
				let player = p[1];
				let statusString = llamastring.substring(llamastring.indexOf(player.nation) + 57, llamastring.indexOf(player.nation) + 64);
				if (statusString === 'Waiting' || player.isAdmin) {
					if (minsLeft <= 90 && !player.isNotified) {
						notify.add(player);
					}
					if (minsLeft <= 15 && !player.isNotifiedUrgent) {
						notifyUrgent.add(player);
					}
				}
				if (minsLeft > 90) player.isNotified = false;
				if (minsLeft > 15) player.isNotifiedUrgent = false;
			}
			if (notify.size > 0) {
				let toSend = '';
				for (player of notify) {
					toSend += '<@' + player.id + '>, ';
				}
				toSend += '90 Minutes left to do your turn';
				channel.send(toSend);
				for (player of notify) {
					player.isNotified = true;
				}
			}
			if (notifyUrgent.size > 0) {
				let toSend = '';
				for (player of notifyUrgent) {
					toSend += '<@' + player.id + '>, ';
				}
				toSend += '15 Minutes left to do your turn!';
				channel.send(toSend);
				for (player of notifyUrgent) {
					player.isNotifiedUrgent = true;
				}
			}		
			//Prod the last guy to do his turn
			//console.log(llamastring);
			
			let chunks = llamastring.split('Waiting');
			if (chunks.length == 2) {
				for (p of game.players) {
					let player = p[1];
					let statusString = llamastring.substring(llamastring.indexOf(player.nation) + 57, llamastring.indexOf(player.nation) + 64);
					if (statusString === 'Waiting' && !player.isNotifiedLast) {
						channel.send('<@' + player.id + '> last');
						player.isNotifiedLast = true;
					}
				}
			} else {
				for (p of game.players) {
					p[1].isNotifiedLast = false;
				}
			}
			//check for new turn
			if (!llamastring.includes('2h file received')) {
				let notifyNewTurn = new Set();
				for (p of game.players) {
					let player = p[1];
					if (!player.isNotifiedNewTurn) {
						notifyNewTurn.add(player);
						player.isNotifiedNewTurn = true;
					}
				}
				if (notifyNewTurn.size > 0) {
					let toSend = '';
					for (player of notifyNewTurn) {
						toSend += '<@' + player.id + '>, ';
					}
					toSend += 'new turn';
					channel.send(toSend);
				}
			} else {
				for (p of game.players) {
					p[1].isNotifiedNewTurn = false;
				}
			}
			//check for stales
			getStalerString(game.name)//TODO nur einmal
			.then(stalerString => channel.send(stalerString))
			.catch(console.log);
		})
		.catch(console.log);
	}
}

//command functions
function help(msg) {
	msg.channel.send('Commands are:\n' +
	config.commandPrefix + 'register <Llamaserver game>\n' +
	config.commandPrefix + 'claim <nation>\n' +
	config.commandPrefix + 'unclaim\n' +
	config.commandPrefix + 'admin\n' +
	config.commandPrefix + 'time');
}
	
function register(msg, args) {
	if (args.length == 0) {
		msg.channel.send(`Usage: ${config.commandPrefix}register <name-of-Llamaserver-game>`);
	}	else if (games.has(msg.channel.id)) {
		msg.channel.send('That game already exists');
	} else {
		getLlamaString(args[0])
		.then(llamastring => {
			game = new Game(msg.channel.id, args[0]);
			//console.log(game);
			games.set(msg.channel.id, game);
			saveGames();
			msg.channel.send(`Game registered. Players can now ${config.commandPrefix}claim`);
		})
		.catch(err => msg.channel.send(err));
	}
}

function claim(msg, args) {
	if (args.length == 0) {
		msg.channel.send(`Usage: ${config.commandPrefix}claim <nation>`);
	}	else if (!games.has(msg.channel.id)) {
		msg.channel.send(`Game does not exist. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		let nation = args[0].charAt(0).toUpperCase() + args[0].slice(1);
		getLlamaString(game.name)
		.then(llamastring => {
			if (game.players.has(msg.author.id)) {
				msg.channel.send('You already claimed a nation.');
			} else if (!llamastring.includes('<td>' + nation.padEnd(15, ' ') + '</td>')) {
				msg.channel.send('This nation is not in the game.');
			}	else {
				let player = new Player(msg.author.id, nation);
				game.players.set(msg.author.id, player);
				saveGames();
				msg.channel.send(`You have claimed the nation ${nation}`);
			}
		})
		.catch(console.log);
	}
}

function unclaim(msg) {
	if (!games.has(msg.channel.id)) {
		msg.channel.send(`Game does not exist. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		if (!game.players.has(msg.author.id)) {
			msg.channel.send('You have not yet claimed a nation.');
		} else {
			msg.channel.send('You have unclaimed the nation ' + game.players.get(msg.author.id).nation);
			game.players.delete(msg.author.id);
		}
	}
}

function admin(msg) {
	if (!games.has(msg.channel.id)) {
				msg.channel.send(`Game does not exist. Use ${config.commandPrefix}register`);
	} else {
			let game = games.get(msg.channel.id);
			if (!game.players.has(msg.author.id)) {
				msg.channel.send(`You are not claimed yet. Use ${config.commandPrefix}claim`);
			} else {
				player = game.players.get(msg.author.id);
				if (player.isAdmin) {
					player.isAdmin = false;
					msg.channel.send('You are no longer an admin.');
				} else {
					player.isAdmin = true;
					msg.channel.send('You are now an admin.');
				}
			}
	}
}

function time(msg) {
	 if (!games.has(msg.channel.id)) {
		msg.channel.send(`Channel is not linked to a Llamaserver game. Use ${config.commandPrefix}register`);
	} else {
		let game = games.get(msg.channel.id);
		getLlamaString(game.name)
		.then(llamastring => {
			let due = llamastring.substring(llamastring.indexOf('Next turn due:') + 15, llamastring.indexOf('<br><br>'));
			let current = llamastring.substring(llamastring.indexOf('Last updated at') + 16, 
				llamastring.indexOf('<a align="right" href="https://pledgie.com'));
			let minsLeft = compareDates(current, due);
			let h = Math.trunc(minsLeft / 60);
			let m = minsLeft % 60;
			msg.channel.send(`There are ${h} hours ${m} minutes left`);
		});
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
			//console.log(llamastring);
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
			for (chunk of chunks) {
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
	for (entry of games) {
		let game = entry[1];
		str += '(' + game.channelId + '+' + game.name;
		for (entry2 of game.players) {
			let player = entry2[1];
			str += '+' + player.id + '-' + player.nation + '-';
			if (player.isAdmin) {
				str += 'a';//admin
			} else {
				str += 'u';//user
			}
		}
		str += ')';
	}
	return str;
}

function gamesFromString(str) {
	let games = new Map();
	while (str.includes('(')) {
		let gameData = str.substring(1, str.indexOf(')'));
		str = str.substring(str.indexOf(')') + 1);
		gameData = gameData.split('+');
		let channelId = gameData.shift();
		let nameOfGame = gameData.shift();
		let game = new Game(channelId, nameOfGame);
		for (userData of gameData) {
			userData = userData.split('-');
			let id = userData.shift();
			let name = userData.shift();
			let player = new Player(id, name)
			if (userData.shift() === 'a') {
				player.isAdmin = true;
			}
			game.players.set(id, player);
		}
		games.set(channelId, game);
	}
	return games;
}

function compareDates(current, due) {//output in minutes
	current = current.split(' ');
	let cTime = current[0];
	let cHours = parseInt(cTime.substring(0, 2));
	let cMinutes = parseInt(cTime.substring(3, 5));
	let cDay = current[3];
	
	due = due.split(' ');
	let dTime = due[0];
	dHours = parseInt(dTime.substring(0, 2));
	dMinutes = parseInt(dTime.substring(3, 5));
	let dDay = due[3];
	
	let days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
	cDay = days.indexOf(cDay);
	dDay = days.indexOf(dDay);
	if (dDay < cDay) dDay += 7;
	return (((dDay - cDay) * 24 + (dHours - cHours)) * 60 + (dMinutes - cMinutes));
}

function saveGames() {
	//console.log(gamesToString(games));
	fs.writeFile('games.dat', gamesToString(games), function (err) {
		if (err) throw err;
		console.log('Games saved');
	});
}

function send(channel, message) {
	if (config.messageMode === "debug") {}
}

//Constructors
function Game(channelId, name) {
	this.channelId = channelId;
	this.name = name;
	this.players = new Map([]);
}

function Player(id, nation) {
	this.id = id;
	this.nation = nation;
	this.isAdmin = false;
	this.isNotified = false;
	this.isNotifiedUrgent = false;
	this.isNotifiedLast = false;
	this.isNotifiedNewTurn = false;
}

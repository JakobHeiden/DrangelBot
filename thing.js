const snekfetch = require('snekfetch');

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

function time(name) {
	getLlamaString(name)
	.then(llamastring => {
		console.log(llamastring);
		let due = llamastring.substring(llamastring.indexOf('Next turn due:') + 15, llamastring.indexOf('<br><br>'));
		let current = llamastring.substring(llamastring.indexOf('Last updated at') + 16, 
			llamastring.indexOf('<a align="right" href="https://pledgie.com'));
			let minsLeft = compareDates(current, due);
			console.log(current, due);
		let h = Math.trunc(minsLeft / 60);
		let m = minsLeft % 60;
		console.log(h, m);
	});
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


/* getLlamastring("PillarOfSalt")
.then(str => {
	let chunks = str.split('<tr>');
	chunks.shift();
	chunks.shift();
	
	let r = '';
	for (chunk of chunks) {
		let chips = chunk.split('&nbsp');
		
		console.log(chips[1], chips[chips.length - 2]);
		console.log(chips[1].length, chips[chips.length - 2].length);
	}
}); */
let n = "PillarOfSalt";
let m = 'the_pretender_itself';
//getStalerString(n)
//.then(console.log);
time(n);
//time(m);

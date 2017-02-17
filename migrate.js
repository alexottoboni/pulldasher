var mysql = require('mysql'),
    config = require('./config'),
    fs = require('fs');

var db = mysql.createConnection({
   host: config.mysql.host,
   database: config.mysql.db,
   user: config.mysql.user,
   password: config.mysql.pass,
   multipleStatements: true
});

console.log("Running this script will initalize your database for pulldasher.");
console.log("It will not drop any existing tables.");

fs.readFile('./schema.sql', function(err, data) {
   if (err) {
      throw err;
   }

   db.query(data.toString(), function(err, res, fields) {
      // If the connection fails, return a failure code so that entrypoint.sh
      // will retry this script.
      if (err) {
         console.log(err);
         process.exit(1);
      }

      db.end(function(err) {
         if (err) {
            throw err;
         }
      });
   });
});

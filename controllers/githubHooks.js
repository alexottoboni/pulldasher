var config     = require('../config'),
    Promise    = require('promise'),
    debug      = require('debug')('pulldasher:githubHooks'),
    Pull       = require('../models/pull'),
    Status     = require('../models/status'),
    Signature  = require('../models/signature'),
    Issue      = require('../models/issue'),
    Comment    = require('../models/comment'),
    Label      = require('../models/label'),
    refresh    = require('../lib/refresh'),
    dbManager  = require('../lib/db-manager');

var HooksController = {

   main: function(req, res) {
      // Variable for promise that will resolve when the hook is known to have
      // succeeded or failed.
      var dbUpdated;
      var comment;

      var secret = req.param('secret');
      if (secret !== config.github.hook_secret) {
         var m = 'Invalid Hook Secret: ' + secret;
         debug(m);
         console.error(m);
         return res.status(401).send('Invalid POST');
      }

      // Begin the webhook decoding
      var body = JSON.parse(req.body.payload);
      var event = req.get('X-GitHub-Event');
      debug('Received GitHub webhook, Event: %s', event);

      if (event === 'status') {
         dbUpdated = dbManager.updateCommitStatus(new Status(body));
      } else if (event === 'issues') {
         dbUpdated = handleIssueEvent(body);
      } else if (event === 'pull_request') {
         // Promise that resolves when everything that needs to be done before
         // we call `updatePull` has finished.
         var preUpdate = Promise.resolve();

         switch(body.action) {
            case "opened":
            case "reopened":
            case "closed":
            case "edited":
            case "merged":
               break;
            case "labeled":
               preUpdate = dbManager.insertLabel(
                  new Label(
                     body.label,
                     body.number,
                     body.pull_request.head.repo.name,
                     body.sender.login,
                     body.pull_request.updated_at
                  )
               );
               break;
            case "unlabeled":
               preUpdate = dbManager.deleteLabel(
                  new Label(
                     body.label,
                     body.number,
                     body.pull_request.head.repo.name
                  )
               );
               break;
            case "synchronize":
               preUpdate = dbManager.invalidateSignatures(
                  body.pull_request.number,
                  ['QA', 'CR']
               );
         }

         // Update DB with new pull request content.
         dbUpdated = preUpdate.then(function() {
            return dbManager.updatePull(new Pull(body.pull_request));
         });
      } else if (event === 'issue_comment') {
         if (body.action === 'created') {
            var promises = [];

            // Parse any signature(s) out of the comment.
            var sigs = Signature.parseComment(body.comment, body.issue.number);
            promises.push(dbManager.insertSignatures(sigs));

            body.comment.number = body.issue.number;
            body.comment.repo = body.repository.name;
            body.comment.type = 'issue';
            comment = new Comment(body.comment);

            promises.push(dbManager.updateComment(comment));

            dbUpdated = Promise.all(promises);
         } else {
            // If the comment was edited or deleted, the easiest way to deal
            // with the result is to simply refresh all data for the pull (or
            // issue). Otherwise, we'd have to delete or update the comment,
            // delete or update any signatures tied to that comment, then
            // delete all signatures and re-insert in order them so the
            // dev_blocking and such comes out correct.
            refreshPullOrIssue(body);
         }
      } else if (event === 'pull_request_review_comment') {
         if (body.action === 'deleted') {
            dbUpdated = dbManager.deleteReviewComment(body.comment.id);
         } else {
            body.comment.number = body.pull_request.number;
            body.comment.repo =   body.repository.name;
            body.comment.type =   'review';
            comment = new Comment(body.comment);

            dbUpdated = dbManager.updateComment(comment);
         }
      }

      if (dbUpdated) {
         dbUpdated.then(function fulfilled() {
            res.status(200).send('Success!');
         },
         function rejected(err) {
            console.log(err);
            res.status(500).send(err.toString());
         }).done();
      } else {
         res.status(200).send('Success!');
      }
   }
};

function handleIssueEvent(body) {
   debug('Webhook action: %s for issue #%s', body.action, body.issue.number);
   var doneHandling = handleLabelEvents(body);

   switch(body.action) {
      case "opened":
         // Always do this for opened issues because a full refresh
         // is the easiest way to get *who* assigned the initial labels.
         return refresh.issue(body.issue.number);

      case "reopened":
      case "closed":
      case "edited":
      case "assigned":
      case "unassigned":
        // Default case is update the issue
   }

   return doneHandling.then(function() {
      return Issue.getFromGH(body.issue);
   })
   .then(dbManager.updateIssue)
   .then(function() {
      return reprocessLabels(body.issue.number, body.repository.name);
   });
}


/**
 * Handles the response body if it represents a labeled / unlabled issue
 * (or pull) event and returns a promise that is fulfilled when the DB change
 * is committed.
 *
 * Note: will return a fulfilled promise if this is not a label event.
 */
function handleLabelEvents(body) {
   switch(body.action) {
      case "labeled":
         debug('Added label: %s', body.label.name);
         return dbManager.insertLabel(new Label(
            body.label,
            body.issue.number,
            body.repository.name,
            body.sender.login,
            body.issue.updated_at
         ));

      case "unlabeled":
         debug('Removed label: %s', body.label.name);
         return dbManager.deleteLabel(new Label(
            body.label,
            body.issue.number,
            body.repository.name
         ));
   }
   return Promise.resolve();
}

/**
 * After a label has been added or removed we have to re-process all the labels
 * in case one of them matches one of our configured label updaters.
 */
function reprocessLabels(issueNumber, repo) {
   if (!config.labels || !config.labels.length) {
      return;
   }
   debug("Reprocessing labels for Issue #%s", issueNumber);
   return dbManager.getIssue(issueNumber, repo)
   .then(dbManager.updateIssue);
}

function refreshPullOrIssue(responseBody) {
   // The Docs: https://developer.github.com/v3/issues/#list-issues say you can
   // tell the difference like this:
   if (responseBody.issue.pull_request) {
      refresh.pull(responseBody.issue.number);
   } else {
      refresh.issue(responseBody.issue.number);
   }
}

module.exports = HooksController;

'use strict';

var transcribaConfig = require('../../server/transcriba-config.json');
var path = require('path');

module.exports = function(user) {
  user.minimumRevisionVotingScore = 30;
  user.maximumRecentRevisionVotes = 20;

  user.afterRemote('confirm', function(context, result, next) {
    // if the user is confirmed he will get the default role
    var role = transcribaConfig.rbac.defaultRole;

    user.app.models.AppUser.setRole(context.req.query.uid, role, function(err) {
      if (err) return next(err);

      return next();
    });
  });

  // send verification email after registration
  user.afterRemote('create', function(context, user, next) {
    console.log('> user.afterRemote triggered');

    var options = {
      type: 'email',
      to: user.email,
      from: transcribaConfig.senderMail,
      subject: 'Bestätigung der Registrierung',
      template: path.resolve(__dirname, '../../server/views/verify.ejs'),
      user: user,
      redirect: '/verified',
      appName: transcribaConfig.appName,
    };

    // local host doesn't matter if people don't access the local server directly
    // so we have to take care that the verification link points to the external ip
    if (!transcribaConfig.isLocalServerEnvironment) {
      options.host = transcribaConfig.appUrl;
      options.port = '80';
    }

    user.verify(options, function(err, response) {
      if (err) return next(err);

      // console.log('> verification email sent:', response);
      return next();
    });
  });

  // send password reset link when requested
  user.on('resetPasswordRequest', function(info) {
    var url = 'http://' + transcribaConfig.appUrl + '/reset-password';
    var html = 'Click <a href="' + url + '?access_token=' +
        info.accessToken.id + '">here</a> to reset your password';

    user.app.models.Email.send({
      to: info.email,
      from: transcribaConfig.senderMail,
      subject: 'Password reset',
      html: html,
    }, function(err) {
      if (err) return console.log('> error sending password reset email');
      console.log('> sending password reset email to:', info.email);
    });
  });

  /**
  * Checks whether the user has the given role or not
  * @param {string} roleName;
  * @callback requestCallback
  * @param {string} err;
  * @param {boolean} hasRole;
  */
  user.prototype.hasRole = function(roleName, callback) {
    this.roles(function(err, roles) {
      if (err) return callback(err);

      var roleNames = roles.map(function(role) {
        return role.name;
      });

      if (roleNames.indexOf(roleName) !== -1) {
        return callback(null, true);
      } else {
        return callback(null, false);
      }
    });
  };

  /**
  * Checks whether the user is mature enough for voting or not
  * @callback requestCallback
  * @param {string} err;
  * @param {boolean} isEligible;
  */
  user.prototype.isEligibleVoter = function(callback) {
    var me = this;
    this.hasRole('trusted', function(err, isTrusted) {
      if (err) callback(err);

      callback(null, me.score >= user.minimumRevisionVotingScore || isTrusted);
    });
  };

  /**
  * Returns the number of recent votes from the current user
  * regarding a certain objectType
  * @param {string} votingModel;
  * @callback requestCallback
  * @param {string} err;
  * @param {number} numOfVotes;
  */
  user.prototype.numOfRecentVotes = function(objectType, callback) {
    var dateDistance = 1000 * 60 * 60 * 24;

    user.app.models.Voting.count({
      'userId': this.id,
      'objectType': objectType,
      'createdAt': {
        'between': [
          new Date(Date.now() - dateDistance),
          new Date(),
        ],
      },
    }, function(err, count) {
      if (err) return callback(err);

      callback(null, count);
    });
  };

  /**
  * The effect of this method depends on the server settings, but
  * it should give the user the specified role plus all roles below in the
  * hierachy (if rbac is hierachical) and delete all above
  * @param {string} id;
  * @param {string} rolename
  * @callback requestCallback
  * @param {string} err
  */
  user.setRole = function(id, rolename, callback) {
    var roles = transcribaConfig.rbac.roles;
    var rolePosition = roles.indexOf(rolename);

    if (rolePosition == -1) return callback('role not found');

    if (transcribaConfig.rbac.hierachical) {
      // delete all roles which are higher than the given role
      // and add all role which are lower than the given role
      //
      user.app.models.AppUser.addRoles(id, roles.slice(0, rolePosition + 1),
        function(err) {
          if (err) return callback(err);
          // hier weiter
          user.app.models.AppUser.removeRoles(
            id,
            roles.slice(rolePosition + 1),
            callback
          );
        }
      );
    } else {
      user.app.models.AppUser.addRole(id, rolename, callback);
    }
  };

  /**
   * Checks if the user is permitted to vote for the given revision
   * @param {Revision} revision
   * @callback requestCallback
   * @param {string} err
   * @param {boolean} isAllowed
   * @param {object} permissionDetails
   */
  user.prototype.isAllowedToVoteForRevision = function(revision, callback) {
    var me = this;

    this.isEligibleVoter(function(err, eligible) {
      if (err) return callback(err);

      me.numOfRecentVotes('Revision', function(err, recentVotes) {
        if (err) return callback(err);

        return callback(null,
          eligible &&
          recentVotes < user.maximumRecentRevisionVotes &&
          revision.ownerId.toJSON() != me.id.toJSON()
          ,
          {
            'eligibleVoter': eligible,
            'maximumVotesReached':
              recentVotes >= user.maximumRecentRevisionVotes,
            'isOwner': revision.ownerId.toJSON() == me.id.toJSON(),
          }
        );
      });
    });
  };

  user.remoteMethod(
    'setRole',
    {
      description: 'Give the user this role',
      accessType: 'WRITE',
      accepts: [
        {arg: 'id', type: 'string'},
        {arg: 'rolename', type: 'string'},
      ],
      http: {path: '/roles', verb: 'post'},
    }
  );

  user.addRoles = function(id, rolenames, callback) {
    if (rolenames.length > 0) {
      var role = rolenames.pop();
      user.app.models.AppUser.addRole(id, role, function(err) {
        if (err) return callback(err);

        user.app.models.AppUser.addRoles(id, rolenames, callback);
      });
    } else {
      callback(null);
    }
  };

  user.removeRoles = function(id, rolenames, callback) {
    if (rolenames.length > 0) {
      var role = rolenames.pop();

      user.app.models.AppUser.removeRole(id, role, function(err) {
        if (err) return callback(err);

        user.app.models.AppUser.removeRoles(id, rolenames, callback);
      });
    } else {
      callback(null);
    }
  };

  /**
   * Add the user to the given role by name.
   * (original src: https://gist.github.com/leftclickben/aa3cf418312c0ffcc547)
   * @param {string} roleName
   * @param {Function} callback
   */
  user.addRole = function(id, rolename, callback) {
    var Role = user.app.models.Role;
    var User = user.app.models.AppUser;
    var RoleMapping = user.app.models.RoleMapping;

    var error;
    var userId = id;

    User.findById(userId, function(err, userObject) {
      if (err) callback(err);

      Role.findOne(
        {
          where: {name: rolename},
        },
        function(err, role) {
          if (err) {
            return callback(err);
          }

          if (!role) {
            error = new Error('Role ' + rolename + ' not found.');
            error['http_code'] = 404;
            return callback(error);
          }

          RoleMapping.findOne(
            {
              where: {
                principalType: RoleMapping.USER,
                principalId: userId,
                roleId: role.id,
              },
            },
            function(err, roleMapping) {
              if (err) {
                return callback(err);
              }

              // role does already exist
              if (roleMapping) {
                return callback();
              }

              //
              // simple version: does not work at the moment
              //
              // userObject.roles.add(role, callback);

              // Classic version with USER principal type
              role.principals.create(
                {
                  principalType: RoleMapping.USER,
                  principalId: userId,
                },
                callback
              );
            }
          );
        }
      );
    });
  };
  user.remoteMethod(
    'addRole',
    {
      accepts: [
        {arg: 'id', type: 'string'},
        {arg: 'rolename', type: 'string'},
      ],
      http: {path: '/:id/roles', verb: 'put'},
    }
  );

  /**
   * Remove the user from the given role by name.
   * (original src: https://gist.github.com/leftclickben/aa3cf418312c0ffcc547)
   *
   * @param {string} roleName
   * @param {Function} callback
   */
  user.removeRole = function(id, rolename, callback) {
    var Role = user.app.models.Role;
    var RoleMapping = user.app.models.RoleMapping;

    var userId = id;

    Role.findOne(
      {
        where: {name: rolename},
      },
      function(err, roleObj) {
        if (err) {
          return callback(err);
        }

        if (!roleObj) {
          // error = new Error('Role ' + rolename + ' not found.');
          // error['http_code'] = 404;
          // return callback(error);
          return callback(null);
        }
        RoleMapping.findOne(
          {
            where: {
              principalType: RoleMapping.USER,
              principalId: userId,
              roleId: roleObj.id,
            },
          },
          function(err, roleMapping) {
            if (err) {
              return callback(err);
            }

            if (!roleMapping) {
              return callback(null);
            }

            roleMapping.destroy(callback);
          }
        );
      }
    );
  };
  user.remoteMethod(
    'removeRole',
    {
      description: 'Remove User to the named role',
      accessType: 'WRITE',
      accepts: [
        {arg: 'id', type: 'string'},
        {arg: 'rolename', type: 'string'},
      ],
      http: {path: '/:id/roles/:rolename', verb: 'delete'},
    }
  );

  user.score = function(req, callback) {
    if (!req.accessToken) callback('bad request');
    var userId = req.accessToken.userId;

    user.findById(userId, function(err, usr) {
      if (err) return callback(err);
      if (!usr) {
        let error = new Error('User ' + userId + ' not found.');
        error['http_code'] = 404;
        return callback(error);
      }

      callback(null, usr.score);
    });
  };

  user.remoteMethod(
    'score',
    {
      description: 'Load the number of score points of the given user',
      accepts: [
        {arg: 'req', type: 'object', required: true, http: {source: 'req'}},
      ],
      returns: [
        {arg: 'score', type: 'number', root: true},
      ],
      http: {path: '/score', verb: 'get'},
      isStatic: true,
    }
  );

  user.busy = function(req, callback) {
    user.findById(req.accessToken.userId, function(err, u) {
      if (err) return callback(err);
      callback(null, u.busy);
    });
  };

  user.remoteMethod(
    'busy',
    {
      description: 'Load busy state of the given user',
      accepts: [
        {arg: 'req', type: 'object', required: true, http: {source: 'req'}},
      ],
      returns: [
        {arg: 'busy', type: 'number', root: true},
      ],
      http: {path: '/busy', verb: 'get'},
      isStatic: true,
    }
  );

  user.leaderboard = function(maxNumOfUsers, callback) {
    if (maxNumOfUsers == undefined) {
      maxNumOfUsers = 10;
    }

    user.find({
      limit: maxNumOfUsers,
      order: 'score desc',
    }, function(err, users) {
      if (err) return callback(err);
      callback(null, users.map(function(u) {
        return {
          'username': u.username,
          'score': u.score,
        };
      }));
    });
  };

  user.remoteMethod(
    'leaderboard',
    {
      description: 'Load the best users',
      accepts: [
        {arg: 'maxNumOfUsers', type: 'number'},
      ],
      returns: [
        {arg: 'scores', type: 'array', root: true},
      ],
      http: {path: '/leaderboard', verb: 'get'},
      isStatic: true,
    }
  );

  // prevent users from logging in as 'bot'
  user.beforeRemote('login', function(context, instance, next) {
    var reqBody = context.req.body;

    if (
      (
        reqBody.username !== undefined &&
        reqBody.username == transcribaConfig.bot.username
      ) ||
      (
        reqBody.email !== undefined &&
        reqBody.email == transcribaConfig.bot.email
      )
    ) {
      next(new Error('cannot login as bot'));
    } else {
      next();
    }
  });

  user.numOfEligibleVoters = function(callback) {
    user.count({
      score: {
        gt: user.minimumRevisionVotingScore - 1,
      },
    }, callback);
  };

  user.disableRemoteMethodByName('__create__roles', false);
  user.disableRemoteMethodByName('__delete__roles', false);
  user.disableRemoteMethodByName('__link__roles', false);
  user.disableRemoteMethodByName('__unlink__roles', false);
  user.disableRemoteMethodByName('__updateById__roles', false);
  user.disableRemoteMethodByName('__findById__roles', false);
  user.disableRemoteMethodByName('__destroyById__roles', false);
  user.disableRemoteMethodByName('__exists__roles', false);
};

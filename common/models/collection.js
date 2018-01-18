'use strict';

const Promise = require('bluebird');
const Exceptions = require('../exceptions.js');

module.exports = function(Collection) {
  /**
   * Add a dynamically calculated progress value to Collection model
   * which indicates the current status of the items included
   */
  Collection.afterRemote('find', function(context, collections) {
    return Promise.map(collections,
      (collectionData) => Collection.findById(collectionData.id).then(
        (collection) => collection.progress()
      )
    ).then(
      (progressArray) => progressArray.forEach(
        (value, index) => collections[index].progress = value
      )
    );
  });

  /**
   * Print thumbnail image
   * @return {Promise}
   */
  Collection.prototype.thumbnail = function() {
    return this.transcribaObjects.find().then(
      (trObjects) => {
        if (trObjects.length === 0) {
          throw Exceptions.NotImplemented;
        } else {
          return trObjects[0].thumbnail();
        }
      }
    );
  };

  /**
   * Current completion status of this collection
   * TODO: make this recursive
   * @param {Function(Error, number)} callback
   */
  Collection.prototype.progress = function() {
    const TranscribaObject = Collection.app.models.TranscribaObject;
    let upperLimit;

    return this.transcribaObjects.find().then(
      (trObjects) => {
        // if no objects are in this collection
        // this means the progress is 100%
        if (trObjects.length === 0) return 1.0;

        // calculate the highest possible amount of accumulated stages
        upperLimit = trObjects.length * TranscribaObject.highestStage;

        return trObjects.reduce(
          (sum, trObject) => sum + trObject.stage
          , 0
        );
      }
    ).then(
      (sum) => sum / upperLimit
    );
  };

  // Using findById method on loaded does not work
  // However, this is being kept, to prevent others to try the same
  // NOTE: remove this if you think you have the reason for that behaviour
  // Collection.observe('loaded', function(ctx) {

  // findById does not seem to load
  // return Collection.findById(ctx.data.id).then(
  //   (currentCollection) => currentCollection.progress()
  // ).then(
  //  (progress) => {
  //    ctx.data.progress = progress;
  //    return;
  //  }
  // ).catch(
  //  (_err) => {
  //    console.log('error was catched during collection loaded hook');
  //    next();
  //  }
  // );
  // });
};

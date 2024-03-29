// dependencies
var async = require('async')
    , AWS = require('aws-sdk')
    , gm = require('gm').subClass({ imageMagick: true }) // Enable ImageMagick integration.
    , util = require('util')
    , request = require('request')
    , config = require('config');

// constants
var MAX_WIDTH = 100
    , MAX_HEIGHT = 100;

// get reference to S3 client 
var s3 = new AWS.S3();

exports.handler = function (event, context) {
    // Read options from the event.
    console.log("Reading options from event:\n", util.inspect(event, { depth: 5 }));
    var srcBucket = event.Records[0].s3.bucket.name;
    var srcKey = event.Records[0].s3.object.key;
    var dstBucket = srcBucket + "-thumbnails";
    var dstKey = "thumb-" + srcKey;

    // Sanity check: validate that source and destination are different buckets.
    if (srcBucket == dstBucket) {
        console.error("Destination bucket must not match source bucket.");
        return;
    }

    // Infer the image type.
    var typeMatch = srcKey.match(/\.([^.]*)$/);
    if (!typeMatch) {
        console.error('unable to infer image type for key ' + srcKey);
        return;
    }

    var validImageTypes = ['png', 'jpg', 'jpeg', 'gif'];
    var imageType = typeMatch[1];
    if (validImageTypes.indexOf(imageType.toLowerCase()) < 0) {
        console.log('skipping non-image ' + srcKey);
        return;
    }

    // Download the image from S3, transform, and upload to a different S3 bucket.
    async.waterfall([
        function download(next) {
            // Download the image from S3 into a buffer.
            s3.getObject({
                Bucket: srcBucket,
                Key: srcKey
            }, next);
        },
        function tranform(response, next) {
            gm(response.Body).size(function (err, size) {
                // Infer the scaling factor to avoid stretching the image unnaturally.
                var scalingFactor = Math.min(
                    MAX_WIDTH / size.width,
                    MAX_HEIGHT / size.height
                );
                var width = scalingFactor * size.width;
                var height = scalingFactor * size.height;

                // Transform the image buffer in memory.
                this.resize(width, height)
                    .toBuffer(imageType, function (err, buffer) {
                        if (err) {
                            next(err);
                        } else {
                            next(null, response.ContentType, buffer);
                        }
                    });
            });
        },
        function upload(contentType, data, next) {
            // Stream the transformed image to a different S3 bucket.
            s3.putObject({
                Bucket: dstBucket,
                Key: dstKey,
                Body: data,
                ContentType: contentType
            }, next);
        }],
        function (err) {
            if (err) {
                console.error(
                    'Unable to resize ' + srcBucket + '/' + srcKey +
                    ' and upload to ' + dstBucket + '/' + dstKey +
                    ' due to an error: ' + err
                );
                context.done();
            } else {
                console.log(
                    'Successfully resized ' + srcBucket + '/' + srcKey +
                    ' and uploaded to ' + dstBucket + '/' + dstKey
                );

                // hash-fileId.ext
                var fileMatch = srcKey.match(/\-([^.]*)\./);

                if (!fileMatch) {
                    context.done();
                } else {
                    var fileId = fileMatch[1];

                    var bucketConfig = config.buckets[srcBucket];
                    request.post(bucketConfig.host + '/api/files/' + fileId + '/thumbnail', {
                        form: {
                            bucket: bucketConfig.bucket,
                            secret: bucketConfig.secret
                        }
                    }, function (err, response, body) {
                        err && console.log('could not make request back: ' + err);
                        context.done();
                    });
                }
            }
        }
    );
};
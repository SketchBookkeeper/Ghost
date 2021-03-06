const _ = require('lodash'),
    Promise = require('bluebird'),
    common = require('../../lib/common');

/**
 * Why and when do we have to fetch `authors` by default?
 *
 * # CASE 1
 * We fetch the `authors` relations when you either request `withRelated=['authors']` or `withRelated=['author`].
 * The old `author` relation was removed, but we still have to support this case.
 *
 * # CASE 2
 * We fetch when editing a post.
 * Imagine you change `author_id` and you have 3 existing `posts_authors`.
 * We now need to set `author_id` as primary author `post.authors[0]`.
 * Furthermore, we now longer have a `author` relationship.
 *
 * # CASE 3:
 * If you request `include=author`, we have to fill this object with `post.authors[0]`.
 * Otherwise we can't return `post.author = User`.
 *
 * ---
 *
 * It's impossible to implement a default `withRelated` feature nicely at the moment, because we can't hook into bookshelf
 * and support all model queries and collection queries (e.g. fetchAll). The hardest part is to remember
 * if the user requested the `authors` or not. Overriding `sync` does not work for collections.
 * And overriding the sync method of Collection does not trigger sync - probably a bookshelf bug, i have
 * not investigated.
 *
 * That's why we remember `_originalOptions` for now - only specific to posts.
 *
 * NOTE: If we fetch the multiple authors manually on the events, we run into the same problem. We have to remember
 * the original options. Plus: we would fetch the authors twice in some cases.
 */
module.exports.extendModel = function extendModel(Post, Posts, ghostBookshelf) {
    const proto = Post.prototype;

    const Model = Post.extend({
        _handleOptions: function _handleOptions(fnName) {
            const self = this;

            return function innerHandleOptions(model, attrs, options) {
                model._originalOptions = _.cloneDeep(_.pick(options, ['withRelated']));

                if (!options.withRelated) {
                    options.withRelated = [];
                }

                if (options.withRelated.indexOf('author') !== -1) {
                    options.withRelated.splice(options.withRelated.indexOf('author'), 1);
                    options.withRelated.push('authors');
                }

                if (options.forUpdate &&
                    ['onFetching', 'onFetchingCollection'].indexOf(fnName) !== -1 &&
                    options.withRelated.indexOf('authors') === -1) {
                    options.withRelated.push('authors');
                }

                return proto[fnName].call(self, model, attrs, options);
            };
        },

        onFetching: function onFetching(model, attrs, options) {
            return this._handleOptions('onFetching')(model, attrs, options);
        },

        onFetchingCollection: function onFetchingCollection(collection, attrs, options) {
            return this._handleOptions('onFetchingCollection')(collection, attrs, options);
        },

        onFetchedCollection: function (collection, attrs, options) {
            _.each(collection.models, ((model) => {
                model._originalOptions = collection._originalOptions;
            }));

            return proto.onFetchingCollection.call(this, collection, attrs, options);
        },

        // NOTE: sending `post.author = {}` was always ignored [unsupported]
        onCreating: function onCreating(model, attrs, options) {
            if (!model.get('author_id')) {
                model.set('author_id', this.contextUser(options));
            }

            if (!model.get('authors')) {
                model.set('authors', [{
                    id: model.get('author_id')
                }]);
            }

            return this._handleOptions('onCreating')(model, attrs, options);
        },

        onUpdating: function onUpdating(model, attrs, options) {
            return this._handleOptions('onUpdating')(model, attrs, options);
        },

        // NOTE: `post.author` was always ignored [unsupported]
        onSaving: function (model, attrs, options) {
            /**
             * @deprecated: `author`, will be removed in Ghost 3.0
             */
            model.unset('author');

            // CASE: you can't delete all authors
            if (model.get('authors') && !model.get('authors').length) {
                throw new common.errors.ValidationError({
                    message: 'At least one author is required.'
                });
            }

            // CASE: `post.author_id` has changed
            if (model.hasChanged('author_id')) {
                // CASE: you don't send `post.authors`
                // SOLUTION: we have to update the primary author
                if (!model.get('authors')) {
                    let existingAuthors = model.related('authors').toJSON();

                    // CASE: override primary author
                    existingAuthors[0] = {
                        id: model.get('author_id')
                    };

                    model.set('authors', existingAuthors);
                } else {
                    // CASE: you send `post.authors` next to `post.author_id`
                    if (model.get('authors')[0].id !== model.get('author_id')) {
                        model.set('author_id', model.get('authors')[0].id);
                    }
                }
            }

            // CASE: if you change `post.author_id`, we have to update the primary author
            // CASE: if the `author_id` has change and you pass `posts.authors`, we already check above that
            //       the primary author id must be equal
            if (model.hasChanged('author_id') && !model.get('authors')) {
                let existingAuthors = model.related('authors').toJSON();

                // CASE: override primary author
                existingAuthors[0] = {
                    id: model.get('author_id')
                };

                model.set('authors', existingAuthors);
            } else if (model.get('authors') && model.get('authors').length) {
                // ensure we update the primary author id
                model.set('author_id', model.get('authors')[0].id);
            }

            return proto.onSaving.call(this, model, attrs, options);
        },

        serialize: function serialize(options) {
            const authors = this.related('authors');

            let attrs = proto.serialize.call(this, options);

            // CASE: e.g. you stub model response in the test
            // CASE: you delete a model without fetching before
            if (!this._originalOptions) {
                this._originalOptions = {};
            }

            /**
             * CASE: `author` was requested, `posts.authors` must exist
             * @deprecated: `author`, will be removed in Ghost 3.0
             */
            if (this._originalOptions.withRelated && this._originalOptions.withRelated && this._originalOptions.withRelated.indexOf('author') !== -1) {
                if (!authors.models.length) {
                    throw new common.errors.ValidationError({
                        message: 'The target post has no primary author.'
                    });
                }

                attrs.author = attrs.authors[0];
                delete attrs.author_id;
            } else {
                // CASE: we return `post.author=id` with or without requested columns.
                // @NOTE: this serialization should be moved into api layer, it's not being moved as it's deprecated
                if (!options.columns || (options.columns && options.columns.indexOf('author') !== -1)) {
                    attrs.author = attrs.author_id;
                    delete attrs.author_id;
                }
            }

            // CASE: `posts.authors` was not requested, but fetched in specific cases (see top)
            if (!this._originalOptions || !this._originalOptions.withRelated || this._originalOptions.withRelated.indexOf('authors') === -1) {
                delete attrs.authors;
            }

            // If the current column settings allow it...
            if (!options.columns || (options.columns && options.columns.indexOf('primary_author') > -1)) {
                // ... attach a computed property of primary_author which is the first author
                if (attrs.authors && attrs.authors.length) {
                    attrs.primary_author = attrs.authors[0];
                } else {
                    attrs.primary_author = null;
                }
            }

            return attrs;
        }
    }, {
        /**
         * ### destroyByAuthor
         * @param  {[type]} options has context and id. Context is the user doing the destroy, id is the user to destroy
         */
        destroyByAuthor: function destroyByAuthor(unfilteredOptions) {
            let options = this.filterOptions(unfilteredOptions, 'destroyByAuthor', {extraAllowedProperties: ['id']}),
                postCollection = Posts.forge(),
                authorId = options.id;

            if (!authorId) {
                return Promise.reject(new common.errors.NotFoundError({
                    message: common.i18n.t('errors.models.post.noUserFound')
                }));
            }

            // CASE: if you are the primary author of a post, the whole post and it's relations get's deleted.
            //       `posts_authors` are automatically removed (bookshelf-relations)
            // CASE: if you are the secondary author of a post, you are just deleted as author.
            //       must happen manually
            const destroyPost = (() => {
                return postCollection
                    .query('where', 'author_id', '=', authorId)
                    .fetch(options)
                    .call('invokeThen', 'destroy', options)
                    .then(function (response) {
                        return (options.transacting || ghostBookshelf.knex)('posts_authors')
                            .where('author_id', authorId)
                            .del()
                            .return(response);
                    })
                    .catch((err) => {
                        throw new common.errors.GhostError({err: err});
                    });
            });

            if (!options.transacting) {
                return ghostBookshelf.transaction((transacting) => {
                    options.transacting = transacting;
                    return destroyPost();
                });
            }

            return destroyPost();
        },

        permissible: function permissible(postModelOrId, action, context, unsafeAttrs, loadedPermissions, hasUserPermission, hasAppPermission) {
            var self = this,
                postModel = postModelOrId,
                origArgs, isContributor, isAuthor, isEdit, isAdd, isDestroy;

            // If we passed in an id instead of a model, get the model
            // then check the permissions
            if (_.isNumber(postModelOrId) || _.isString(postModelOrId)) {
                // Grab the original args without the first one
                origArgs = _.toArray(arguments).slice(1);

                // Get the actual post model
                return this.findOne({id: postModelOrId, status: 'all'}, {withRelated: ['authors']})
                    .then(function then(foundPostModel) {
                        if (!foundPostModel) {
                            throw new common.errors.NotFoundError({
                                level: 'critical',
                                message: common.i18n.t('errors.models.post.postNotFound')
                            });
                        }

                        // Build up the original args but substitute with actual model
                        const newArgs = [foundPostModel].concat(origArgs);
                        return self.permissible.apply(self, newArgs);
                    });
            }

            isContributor = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Contributor'});
            isAuthor = loadedPermissions.user && _.some(loadedPermissions.user.roles, {name: 'Author'});
            isEdit = (action === 'edit');
            isAdd = (action === 'add');
            isDestroy = (action === 'destroy');

            function isChanging(attr) {
                return unsafeAttrs[attr] && unsafeAttrs[attr] !== postModel.get(attr);
            }

            function isChangingAuthors() {
                if (!unsafeAttrs.authors) {
                    return false;
                }

                if (!unsafeAttrs.authors.length) {
                    return true;
                }

                return unsafeAttrs.authors[0].id !== postModel.related('authors').models[0].id;
            }

            function isOwner() {
                let isCorrectOwner = true;

                if (!unsafeAttrs.author_id && !unsafeAttrs.authors) {
                    return false;
                }

                if (unsafeAttrs.author_id) {
                    isCorrectOwner = unsafeAttrs.author_id && unsafeAttrs.author_id === context.user;
                }

                if (unsafeAttrs.authors) {
                    isCorrectOwner = isCorrectOwner && unsafeAttrs.authors.length && unsafeAttrs.authors[0].id === context.user;
                }

                return isCorrectOwner;
            }

            function isCurrentOwner() {
                return postModel.related('authors').models.map(author => author.id).includes(context.user);
            }

            if (isContributor && isEdit) {
                hasUserPermission = !isChanging('author_id') && !isChangingAuthors() && isCurrentOwner();
            } else if (isContributor && isAdd) {
                hasUserPermission = isOwner();
            } else if (isContributor && isDestroy) {
                hasUserPermission = isCurrentOwner();
            } else if (isAuthor && isEdit) {
                hasUserPermission = isCurrentOwner() && !isChanging('author_id') && !isChangingAuthors();
            } else if (isAuthor && isAdd) {
                hasUserPermission = isOwner();
            } else if (postModel) {
                hasUserPermission = hasUserPermission || isCurrentOwner();
            }

            if (hasUserPermission && hasAppPermission) {
                return Post.permissible.call(
                    this,
                    postModelOrId,
                    action, context,
                    unsafeAttrs,
                    loadedPermissions,
                    hasUserPermission,
                    hasAppPermission
                ).then(({excludedAttrs}) => {
                    // @TODO: we need a concept for making a diff between incoming authors and existing authors
                    // @TODO: for now we simply re-use the new concept of `excludedAttrs`
                    // We only check the primary author of `authors`, any other change will be ignored.
                    // By this we can deprecate `author_id` more easily.
                    if (isContributor || isAuthor) {
                        return {
                            excludedAttrs: ['authors'].concat(excludedAttrs)
                        };
                    }
                    return {excludedAttrs};
                });
            }

            return Promise.reject(new common.errors.NoPermissionError({
                message: common.i18n.t('errors.models.post.notEnoughPermission')
            }));
        }
    });

    return Model;
};
